import shutil
import subprocess

import pytest

from audio_analyzer import diarize, pipeline, transcribe
from audio_analyzer.models import Segment, SpeakerTurn, Word

pytestmark = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not installed")


@pytest.fixture
def tone(tmp_path):
    path = tmp_path / "tone.mp3"
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
                    str(path)], check=True)
    return path


def test_pipeline_converts_audio_and_merges_stages(tone, monkeypatch):
    seen = {}

    def fake_transcribe(wav, language=None, model_name=None, on_progress=None):
        seen["wav"] = wav.read_bytes()[:4]
        on_progress(1.0)
        return [Segment(0, 3, "สวัสดี ครับ", words=[Word(0, 1.4, "สวัสดี"), Word(1.6, 3, " ครับ")])], "th", 3.0

    monkeypatch.setattr(transcribe, "transcribe", fake_transcribe)
    monkeypatch.setattr(diarize, "diarize", lambda wav, **kw: [SpeakerTurn(0, 1.5, "S1"), SpeakerTurn(1.5, 3, "S0")])

    stages = []
    result = pipeline.run(tone, "tone.mp3", pipeline.Options(topic_engine="local"), lambda s, f: stages.append(f))

    assert seen["wav"] == b"RIFF"  # ffmpeg produced a WAV for the models
    assert [u.speaker for u in result.utterances] == ["ผู้พูด 1", "ผู้พูด 2"]
    assert result.engines["diarization"] == "pyannote"
    assert len(result.topics) == 1
    assert stages == sorted(stages) and stages[-1] == 1.0


def test_pipeline_without_diarization_token(tone, monkeypatch):
    monkeypatch.setattr(transcribe, "transcribe",
                        lambda wav, **kw: ([Segment(0, 2, "hello", words=[Word(0, 2, "hello")])], "en", 3.0))

    def unavailable(*a, **kw):
        raise diarize.DiarizationUnavailable("ยังไม่ได้ตั้งค่า HF_TOKEN")

    monkeypatch.setattr(diarize, "diarize", unavailable)
    result = pipeline.run(tone, "tone.mp3", pipeline.Options(topic_engine="local"))
    assert result.engines["diarization"] == "none"
    assert result.engines["notes"] == ["ยังไม่ได้ตั้งค่า HF_TOKEN"]
    assert result.utterances[0].speaker == "ผู้พูด 1"
