"""Plain data structures shared across the pipeline."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field


@dataclass
class Word:
    start: float
    end: float
    text: str


@dataclass
class Segment:
    """A chunk of transcribed speech (from Whisper)."""

    start: float
    end: float
    text: str
    words: list[Word] = field(default_factory=list)
    speaker: str | None = None


@dataclass
class SpeakerTurn:
    """A time range attributed to one speaker (from diarization)."""

    start: float
    end: float
    speaker: str


@dataclass
class Utterance:
    """Consecutive speech by one speaker — the unit shown in the transcript."""

    id: int
    start: float
    end: float
    speaker: str
    text: str


@dataclass
class Topic:
    id: int
    title: str
    summary: str
    start: float
    end: float
    utterance_ids: list[int]
    key_points: list[str] = field(default_factory=list)
    speakers: list[str] = field(default_factory=list)


@dataclass
class AnalysisResult:
    filename: str
    language: str
    duration: float
    speakers: list[dict]
    utterances: list[Utterance]
    topics: list[Topic]
    overall_summary: str = ""
    engines: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return asdict(self)
