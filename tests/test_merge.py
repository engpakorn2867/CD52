from audio_analyzer.merge import build_utterances, rename_speakers, speaker_for, speaker_stats
from audio_analyzer.models import Segment, SpeakerTurn, Word


def test_speaker_for_picks_max_overlap_and_nearest_for_gaps():
    turns = [SpeakerTurn(0, 5, "A"), SpeakerTurn(5, 10, "B")]
    assert speaker_for(4, 7, turns) == "B"
    assert speaker_for(1, 2, turns) == "A"
    assert speaker_for(11, 12, turns) == "B"  # after the last turn
    assert speaker_for(1, 2, []) == "SPEAKER_00"


def test_segment_spanning_speaker_change_is_split_by_word():
    seg = Segment(0, 4, "สวัสดีครับ ดีค่ะ", words=[
        Word(0.0, 1.0, "สวัสดี"), Word(1.0, 1.8, "ครับ"),
        Word(2.2, 3.0, " ดี"), Word(3.0, 3.8, "ค่ะ"),
    ])
    turns = [SpeakerTurn(0, 2.0, "SPEAKER_01"), SpeakerTurn(2.0, 4.0, "SPEAKER_00")]
    utts = build_utterances([seg], turns)
    assert [(u.speaker, u.text) for u in utts] == [("SPEAKER_01", "สวัสดีครับ"), ("SPEAKER_00", "ดีค่ะ")]

    mapping = rename_speakers(utts)
    assert mapping == {"SPEAKER_01": "ผู้พูด 1", "SPEAKER_00": "ผู้พูด 2"}
    stats = speaker_stats(utts)
    assert {s["name"] for s in stats} == {"ผู้พูด 1", "ผู้พูด 2"}
    assert round(sum(s["share"] for s in stats)) == 100


def test_long_pause_splits_same_speaker():
    segs = [Segment(0, 1, "a", words=[Word(0, 1, "a")]), Segment(10, 11, "b", words=[Word(10, 11, " b")])]
    utts = build_utterances(segs, [])
    assert [u.text for u in utts] == ["a", "b"]
    assert [u.id for u in utts] == [0, 1]
