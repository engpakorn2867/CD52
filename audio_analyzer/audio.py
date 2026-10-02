"""Audio normalisation via ffmpeg."""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path


def ensure_ffmpeg() -> None:
    if shutil.which("ffmpeg") is None:
        raise RuntimeError("ไม่พบ ffmpeg — กรุณาติดตั้ง ffmpeg ก่อน (เช่น apt install ffmpeg / brew install ffmpeg)")


def to_wav_16k_mono(src: Path, dst: Path) -> Path:
    """Convert any audio/video file into 16 kHz mono WAV, the format both models expect."""
    ensure_ffmpeg()
    cmd = [
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        "-i", str(src), "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", str(dst),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(f"แปลงไฟล์เสียงไม่สำเร็จ: {proc.stderr.strip()}")
    return dst


def duration_seconds(path: Path) -> float:
    if shutil.which("ffprobe") is None:
        return 0.0
    proc = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "json", str(path)],
        capture_output=True, text=True,
    )
    try:
        return float(json.loads(proc.stdout)["format"]["duration"])
    except (KeyError, ValueError, json.JSONDecodeError):
        return 0.0
