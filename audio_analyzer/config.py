"""Runtime settings, read from environment variables."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path


def _env(name: str, default: str | None = None) -> str | None:
    value = os.environ.get(name)
    return value if value not in (None, "") else default


@dataclass(frozen=True)
class Settings:
    # Whisper model size: tiny, base, small, medium, large-v3, large-v3-turbo
    whisper_model: str = field(default_factory=lambda: _env("WHISPER_MODEL", "large-v3-turbo"))
    # "auto" picks cuda when available, otherwise cpu
    device: str = field(default_factory=lambda: _env("DEVICE", "auto"))
    # Hugging Face token, needed for pyannote speaker diarization
    hf_token: str | None = field(default_factory=lambda: _env("HF_TOKEN"))
    diarization_model: str = field(
        default_factory=lambda: _env("DIARIZATION_MODEL", "pyannote/speaker-diarization-3.1")
    )
    # Topic analysis: "auto" uses Claude when credentials exist, otherwise local
    topic_engine: str = field(default_factory=lambda: _env("TOPIC_ENGINE", "auto"))
    claude_model: str = field(default_factory=lambda: _env("CLAUDE_MODEL", "claude-opus-5-5"))
    data_dir: Path = field(default_factory=lambda: Path(_env("DATA_DIR", "data")))


settings = Settings()
