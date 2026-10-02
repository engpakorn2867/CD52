"""Split a transcript into topics.

Two engines:
- ``claude``: Claude reads the whole transcript and returns titled, summarised topics.
- ``local``: offline TextTiling-style segmentation on TF-IDF similarity; titles are keywords.
"""

from __future__ import annotations

import json
import logging
import re
from collections import Counter

from .config import settings
from .models import Topic, Utterance

log = logging.getLogger(__name__)


def fmt_time(seconds: float) -> str:
    seconds = int(seconds)
    h, rem = divmod(seconds, 3600)
    m, s = divmod(rem, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m:02d}:{s:02d}"


def _finalise(utterances: list[Utterance], spans: list[dict]) -> list[Topic]:
    """Turn utterance-index spans into Topic objects with times and speakers filled in."""
    topics = []
    for i, span in enumerate(spans):
        chunk = utterances[span["start"] : span["end"] + 1]
        if not chunk:
            continue
        speakers = list(dict.fromkeys(u.speaker for u in chunk))
        topics.append(
            Topic(
                id=i,
                title=span["title"],
                summary=span.get("summary", ""),
                key_points=span.get("key_points", []),
                start=chunk[0].start,
                end=chunk[-1].end,
                utterance_ids=[u.id for u in chunk],
                speakers=speakers,
            )
        )
    return topics


# ---------------------------------------------------------------- Claude engine

TOPIC_SCHEMA = {
    "type": "object",
    "properties": {
        "overall_summary": {"type": "string"},
        "topics": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "title": {"type": "string"},
                    "summary": {"type": "string"},
                    "key_points": {"type": "array", "items": {"type": "string"}},
                    "start_utterance_id": {"type": "integer"},
                    "end_utterance_id": {"type": "integer"},
                },
                "required": ["title", "summary", "key_points", "start_utterance_id", "end_utterance_id"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["overall_summary", "topics"],
    "additionalProperties": False,
}

SYSTEM_PROMPT = """You analyse transcripts of recorded speech (meetings, interviews, lectures, podcasts).
Split the transcript into its distinct topics, in chronological order, so that every utterance belongs to exactly one topic.
A topic is a stretch of conversation about one subject; start a new topic when the subject clearly changes, not on every small tangent.
Transcripts come from automatic speech recognition and may contain mis-heard words — infer the intended meaning.
Write titles, summaries and key points in the same language as the transcript (Thai transcript → Thai output).
Titles are short (under ~10 words). Summaries are 1-3 sentences and mention who said what when it matters.
Use the bracketed utterance ids to mark where each topic starts and ends."""


def _claude_topics(utterances: list[Utterance]) -> tuple[list[Topic], str]:
    import anthropic

    lines = [f"[{u.id}] ({fmt_time(u.start)}) {u.speaker}: {u.text}" for u in utterances]
    client = anthropic.Anthropic()
    with client.beta.messages.stream(
        model=settings.claude_model,
        max_tokens=64000,
        betas=["server-side-fallback-2026-07-01"],
        fallbacks="default",
        thinking={"type": "adaptive"},
        output_config={
            "effort": "medium",
            "format": {"type": "json_schema", "schema": TOPIC_SCHEMA},
        },
        system=SYSTEM_PROMPT,
        messages=[{"role": "user", "content": "<transcript>\n" + "\n".join(lines) + "\n</transcript>"}],
    ) as stream:
        response = stream.get_final_message()

    if response.stop_reason == "refusal":
        raise RuntimeError("Claude ปฏิเสธการวิเคราะห์ transcript นี้")
    if response.stop_reason == "max_tokens":
        raise RuntimeError("ผลลัพธ์จาก Claude ยาวเกิน max_tokens")
    text = next(b.text for b in response.content if b.type == "text")
    data = json.loads(text)
    return _spans_from_claude(utterances, data["topics"]), data["overall_summary"]


def _spans_from_claude(utterances: list[Utterance], raw: list[dict]) -> list[Topic]:
    """Repair overlaps/gaps so topics tile the transcript exactly."""
    last = len(utterances) - 1
    raw = sorted(raw, key=lambda t: t["start_utterance_id"])
    spans: list[dict] = []
    for i, t in enumerate(raw):
        start = 0 if i == 0 else spans[-1]["end"] + 1
        nxt = raw[i + 1]["start_utterance_id"] - 1 if i + 1 < len(raw) else last
        end = min(max(nxt, start), last)
        if start > last:
            break
        spans.append(
            {"start": start, "end": end, "title": t["title"], "summary": t["summary"], "key_points": t["key_points"]}
        )
    return _finalise(utterances, spans)


# ---------------------------------------------------------------- Local engine

try:  # optional: proper Thai word segmentation for keyword titles
    from pythainlp.corpus import thai_stopwords
    from pythainlp.tokenize import word_tokenize as _thai_tokenize

    _STOPWORDS = set(thai_stopwords())
except ImportError:  # pragma: no cover - depends on optional dependency
    _thai_tokenize = None
    _STOPWORDS = set()

_STOPWORDS |= {
    "the", "a", "an", "and", "or", "but", "is", "are", "was", "were", "to", "of", "in", "on", "for",
    "it", "that", "this", "with", "you", "i", "we", "they", "so", "like", "just", "yeah", "um", "uh",
    "ครับ", "ค่ะ", "คะ", "นะ", "อะ", "เออ", "อืม", "แบบ", "ก็", "ว่า", "คือ", "มัน", "จะ", "ได้", "ที่",
}


def _tokens(text: str) -> list[str]:
    if _thai_tokenize is not None:
        toks = _thai_tokenize(text, keep_whitespace=False)
    else:
        # \w misses Thai vowel/tone marks, so include the whole Thai block explicitly
        toks = re.findall(r"[\w\u0E00-\u0E7F]+", text)
    return [t.lower() for t in toks if len(t) > 1 and t.lower() not in _STOPWORDS and not t.isdigit()]


def _block_similarity(texts: list[str], window: int) -> list[float]:
    """Cosine similarity between the `window` utterances before and after each gap."""
    import numpy as np
    from sklearn.feature_extraction.text import TfidfVectorizer
    from sklearn.metrics.pairwise import cosine_similarity

    # Character n-grams work for Thai, which has no spaces between words.
    vec = TfidfVectorizer(analyzer="char_wb", ngram_range=(2, 4), sublinear_tf=True)
    matrix = vec.fit_transform(texts)
    sims = []
    for gap in range(1, len(texts)):
        left = np.asarray(matrix[max(0, gap - window) : gap].sum(axis=0))
        right = np.asarray(matrix[gap : gap + window].sum(axis=0))
        sims.append(float(cosine_similarity(left, right)[0, 0]))
    return sims


def _local_spans(utterances: list[Utterance], target_seconds: float = 180.0) -> list[dict]:
    n = len(utterances)
    duration = utterances[-1].end - utterances[0].start if n else 0
    if n < 6 or duration < target_seconds * 1.5:
        return [{"start": 0, "end": n - 1}]

    texts = [u.text for u in utterances]
    sims = _block_similarity(texts, window=max(2, min(6, n // 10)))
    # Depth score: how much lower a gap is than the peaks around it (TextTiling).
    depths = []
    for i, s in enumerate(sims):
        left_peak = max(sims[: i + 1])
        right_peak = max(sims[i:])
        depths.append((left_peak - s) + (right_peak - s))

    # At most one boundary per `target_seconds`, and only where the dip is clearly
    # deeper than average — so a long single-subject talk stays one topic.
    wanted = max(1, round(duration / target_seconds)) - 1
    mean = sum(depths) / len(depths)
    std = (sum((d - mean) ** 2 for d in depths) / len(depths)) ** 0.5
    cutoff = max(mean + std / 2, 1e-6)
    min_gap = max(3, n // (wanted + 1) // 3)
    boundaries: list[int] = []
    for idx in sorted(range(len(depths)), key=lambda i: -depths[i]):
        if len(boundaries) >= wanted or depths[idx] < cutoff:
            break
        cut = idx + 1  # boundary before utterance `cut`
        if all(abs(cut - b) >= min_gap for b in boundaries) and min_gap <= cut <= n - min_gap:
            boundaries.append(cut)
    boundaries.sort()
    edges = [0, *boundaries, n]
    return [{"start": edges[i], "end": edges[i + 1] - 1} for i in range(len(edges) - 1)]


def _local_topics(utterances: list[Utterance]) -> tuple[list[Topic], str]:
    spans = _local_spans(utterances)
    docs = [Counter(_tokens(" ".join(u.text for u in utterances[s["start"] : s["end"] + 1]))) for s in spans]
    doc_freq = Counter(tok for d in docs for tok in d)
    for span, counts in zip(spans, docs):
        # Prefer words frequent in this topic but rare in the others.
        scored = sorted(counts, key=lambda t: -(counts[t] / doc_freq[t]) * min(counts[t], 5))
        keywords = scored[:4]
        chunk = utterances[span["start"] : span["end"] + 1]
        longest = max(chunk, key=lambda u: len(u.text))
        span["title"] = " · ".join(keywords) if keywords else f"ช่วงที่ {len(spans)}"
        span["summary"] = longest.text[:240] + ("…" if len(longest.text) > 240 else "")
        span["key_points"] = []
    return _finalise(utterances, spans), ""


# ---------------------------------------------------------------- Entry point


def _claude_available() -> bool:
    try:
        import anthropic  # noqa: F401
    except ImportError:
        return False
    import os

    return bool(os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN"))


def analyse_topics(utterances: list[Utterance], engine: str | None = None) -> tuple[list[Topic], str, str]:
    """Return (topics, overall_summary, engine_used)."""
    if not utterances:
        return [], "", "none"
    engine = engine or settings.topic_engine
    if engine == "auto":
        engine = "claude" if _claude_available() else "local"
    if engine == "claude":
        try:
            topics, summary = _claude_topics(utterances)
            return topics, summary, "claude"
        except Exception as exc:  # fall back rather than lose the transcript
            log.warning("Claude topic analysis failed, using local engine: %s", exc)
    topics, summary = _local_topics(utterances)
    return topics, summary, "local"
