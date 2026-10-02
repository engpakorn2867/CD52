"""Speaker diarization (who spoke when) with pyannote.audio."""

from __future__ import annotations

import logging
from functools import lru_cache
from pathlib import Path

from .config import settings
from .models import SpeakerTurn

log = logging.getLogger(__name__)


class DiarizationUnavailable(RuntimeError):
    pass


@lru_cache(maxsize=1)
def _load_pipeline():
    if not settings.hf_token:
        raise DiarizationUnavailable(
            "ยังไม่ได้ตั้งค่า HF_TOKEN — ข้ามการแยกผู้พูด (ดูวิธีตั้งค่าใน README)"
        )
    try:
        import torch
        from pyannote.audio import Pipeline
    except ImportError as exc:
        raise DiarizationUnavailable("ยังไม่ได้ติดตั้ง pyannote.audio") from exc

    try:
        pipeline = Pipeline.from_pretrained(settings.diarization_model, token=settings.hf_token)
    except TypeError:  # pyannote.audio 3.x names the argument differently
        pipeline = Pipeline.from_pretrained(settings.diarization_model, use_auth_token=settings.hf_token)
    if pipeline is None:
        raise DiarizationUnavailable(
            f"โหลดโมเดล {settings.diarization_model} ไม่ได้ — ต้องกดยอมรับเงื่อนไขของโมเดลบน Hugging Face ก่อน"
        )
    if settings.device in ("auto", "cuda") and torch.cuda.is_available():
        pipeline.to(torch.device("cuda"))
    return pipeline


def diarize(
    wav_path: Path,
    num_speakers: int | None = None,
    min_speakers: int | None = None,
    max_speakers: int | None = None,
) -> list[SpeakerTurn]:
    pipeline = _load_pipeline()
    kwargs = {}
    if num_speakers:
        kwargs["num_speakers"] = num_speakers
    else:
        if min_speakers:
            kwargs["min_speakers"] = min_speakers
        if max_speakers:
            kwargs["max_speakers"] = max_speakers
    annotation = pipeline(str(wav_path), **kwargs)
    # pyannote >= 3.3 may wrap the annotation in an output object
    annotation = getattr(annotation, "speaker_diarization", annotation)
    turns = [
        SpeakerTurn(start=turn.start, end=turn.end, speaker=label)
        for turn, _, label in annotation.itertracks(yield_label=True)
    ]
    turns.sort(key=lambda t: t.start)
    return turns
