"""Combine Whisper words with diarization turns into speaker-labelled utterances."""

from __future__ import annotations

from .models import Segment, SpeakerTurn, Utterance, Word

UNKNOWN_SPEAKER = "SPEAKER_00"
# Start a new utterance when the same speaker pauses this long (seconds)
PAUSE_SPLIT = 2.0
# ...or when an utterance grows past this length (seconds)
MAX_UTTERANCE = 45.0


def _overlap(a_start: float, a_end: float, b_start: float, b_end: float) -> float:
    return max(0.0, min(a_end, b_end) - max(a_start, b_start))


def speaker_for(start: float, end: float, turns: list[SpeakerTurn]) -> str:
    """Speaker with the most overlap; falls back to the nearest turn for gaps."""
    if not turns:
        return UNKNOWN_SPEAKER
    best, best_overlap = None, 0.0
    for turn in turns:
        if turn.start > end:
            break
        ov = _overlap(start, end, turn.start, turn.end)
        if ov > best_overlap:
            best, best_overlap = turn.speaker, ov
    if best is not None:
        return best
    mid = (start + end) / 2
    nearest = min(turns, key=lambda t: min(abs(mid - t.start), abs(mid - t.end)))
    return nearest.speaker


def build_utterances(segments: list[Segment], turns: list[SpeakerTurn]) -> list[Utterance]:
    # Work at word level when timestamps exist — a Whisper segment can span a speaker change.
    tokens: list[tuple[Word, str]] = []
    for seg in segments:
        words = seg.words or [Word(start=seg.start, end=seg.end, text=seg.text)]
        for w in words:
            tokens.append((w, speaker_for(w.start, w.end, turns)))

    utterances: list[Utterance] = []
    cur_words: list[Word] = []
    cur_speaker: str | None = None

    def flush() -> None:
        if not cur_words:
            return
        text = "".join(w.text for w in cur_words).strip()
        if text:
            utterances.append(
                Utterance(
                    id=len(utterances),
                    start=round(cur_words[0].start, 2),
                    end=round(cur_words[-1].end, 2),
                    speaker=cur_speaker or UNKNOWN_SPEAKER,
                    text=" ".join(text.split()),
                )
            )

    for word, speaker in tokens:
        if cur_words:
            new_speaker = speaker != cur_speaker
            long_pause = word.start - cur_words[-1].end > PAUSE_SPLIT
            too_long = word.end - cur_words[0].start > MAX_UTTERANCE
            if new_speaker or long_pause or too_long:
                flush()
                cur_words = []
        if not cur_words:
            cur_speaker = speaker
        cur_words.append(word)
    flush()
    return utterances


def rename_speakers(utterances: list[Utterance]) -> dict[str, str]:
    """Map raw labels (SPEAKER_03) to friendly names in order of first appearance."""
    mapping: dict[str, str] = {}
    for u in utterances:
        if u.speaker not in mapping:
            mapping[u.speaker] = f"ผู้พูด {len(mapping) + 1}"
        u.speaker = mapping[u.speaker]
    return mapping


def speaker_stats(utterances: list[Utterance]) -> list[dict]:
    totals: dict[str, dict] = {}
    for u in utterances:
        s = totals.setdefault(u.speaker, {"name": u.speaker, "talk_time": 0.0, "turns": 0})
        s["talk_time"] += u.end - u.start
        s["turns"] += 1
    grand = sum(s["talk_time"] for s in totals.values()) or 1.0
    for s in totals.values():
        s["talk_time"] = round(s["talk_time"], 1)
        s["share"] = round(100 * s["talk_time"] / grand, 1)
    return sorted(totals.values(), key=lambda s: -s["talk_time"])
