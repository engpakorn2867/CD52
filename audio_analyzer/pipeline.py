"""End-to-end pipeline: audio file -> transcript -> speakers -> topics."""

from __future__ import annotations

import logging
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from . import audio, diarize, merge, topics, transcribe
from .models import AnalysisResult

log = logging.getLogger(__name__)

ProgressFn = Callable[[str, float], None]


@dataclass
class Options:
    language: str | None = None  # e.g. "th", "en"; None = auto-detect
    num_speakers: int | None = None
    min_speakers: int | None = None
    max_speakers: int | None = None
    diarize: bool = True
    topic_engine: str | None = None  # "auto" | "claude" | "local"
    whisper_model: str | None = None


def run(src: Path, filename: str, opts: Options, progress: ProgressFn | None = None) -> AnalysisResult:
    report = progress or (lambda stage, frac: None)
    notes: list[str] = []

    with tempfile.TemporaryDirectory() as tmp:
        report("กำลังเตรียมไฟล์เสียง", 0.02)
        wav = audio.to_wav_16k_mono(src, Path(tmp) / "audio.wav")

        report("กำลังถอดเสียงเป็นข้อความ", 0.05)
        segments, language, duration = transcribe.transcribe(
            wav,
            language=opts.language,
            model_name=opts.whisper_model,
            on_progress=lambda f: report("กำลังถอดเสียงเป็นข้อความ", 0.05 + 0.55 * f),
        )

        turns = []
        diar_engine = "none"
        if opts.diarize:
            report("กำลังวิเคราะห์และแยกผู้พูด", 0.62)
            try:
                turns = diarize.diarize(
                    wav,
                    num_speakers=opts.num_speakers,
                    min_speakers=opts.min_speakers,
                    max_speakers=opts.max_speakers,
                )
                diar_engine = "pyannote"
            except diarize.DiarizationUnavailable as exc:
                log.warning("%s", exc)
                notes.append(str(exc))

    report("กำลังจัดเรียงบทสนทนา", 0.80)
    utterances = merge.build_utterances(segments, turns)
    merge.rename_speakers(utterances)

    report("กำลังวิเคราะห์และแยกหัวข้อ", 0.85)
    topic_list, overall, topic_engine = topics.analyse_topics(utterances, opts.topic_engine)

    report("เสร็จสิ้น", 1.0)
    return AnalysisResult(
        filename=filename,
        language=language,
        duration=round(duration, 2),
        speakers=merge.speaker_stats(utterances),
        utterances=utterances,
        topics=topic_list,
        overall_summary=overall,
        engines={
            "transcription": f"faster-whisper ({opts.whisper_model or transcribe.settings.whisper_model})",
            "diarization": diar_engine,
            "topics": topic_engine,
            "notes": notes,
        },
    )
