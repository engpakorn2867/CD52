"""Speech-to-text with faster-whisper (runs locally)."""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import Callable

from .config import settings
from .models import Segment, Word


def _resolve_device() -> tuple[str, str]:
    device = settings.device
    if device == "auto":
        try:
            import torch

            device = "cuda" if torch.cuda.is_available() else "cpu"
        except ImportError:
            device = "cpu"
    compute_type = "float16" if device == "cuda" else "int8"
    return device, compute_type


@lru_cache(maxsize=2)
def _load_model(name: str):
    from faster_whisper import WhisperModel

    device, compute_type = _resolve_device()
    return WhisperModel(name, device=device, compute_type=compute_type)


def transcribe(
    wav_path: Path,
    language: str | None = None,
    model_name: str | None = None,
    on_progress: Callable[[float], None] | None = None,
) -> tuple[list[Segment], str, float]:
    """Return (segments, detected_language, duration)."""
    model = _load_model(model_name or settings.whisper_model)
    raw_segments, info = model.transcribe(
        str(wav_path),
        language=language or None,
        word_timestamps=True,
        vad_filter=True,
        beam_size=5,
    )
    segments: list[Segment] = []
    duration = float(info.duration or 0.0)
    for seg in raw_segments:  # generator — transcription happens while iterating
        words = [Word(start=w.start, end=w.end, text=w.word) for w in (seg.words or [])]
        segments.append(Segment(start=seg.start, end=seg.end, text=seg.text.strip(), words=words))
        if on_progress and duration:
            on_progress(min(seg.end / duration, 1.0))
    return segments, info.language, duration
