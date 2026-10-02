from audio_analyzer import topics
from audio_analyzer.models import Utterance


def _utts(texts, step=20.0):
    return [Utterance(id=i, start=i * step, end=i * step + step - 1, speaker=f"ผู้พูด {i % 2 + 1}", text=t)
            for i, t in enumerate(texts)]


def test_local_engine_finds_topic_change_and_tiles_transcript():
    cooking = ["วันนี้เราจะทำต้มยำกุ้ง ใส่ข่าตะไคร้ใบมะกรูด", "ต้มน้ำให้เดือดแล้วใส่กุ้งลงไปในหม้อ",
               "ปรุงรสต้มยำด้วยน้ำปลามะนาวพริก", "ชิมน้ำต้มยำกุ้งดูว่าเปรี้ยวพอไหม",
               "ตักต้มยำกุ้งใส่ชามโรยผักชี", "กุ้งสดทำให้ต้มยำอร่อยมาก", "ข่าตะไคร้ต้องทุบก่อนใส่หม้อ",
               "ต้มยำน้ำข้นใส่นมด้วยก็ได้", "เคล็ดลับต้มยำคือกุ้งต้องสด", "ต้มยำกุ้งเสร็จแล้วพร้อมเสิร์ฟ"]
    football = ["เมื่อคืนดูฟุตบอลแมนยูเตะกับลิเวอร์พูล", "ลิเวอร์พูลยิงประตูแรกนาทีที่สิบ",
                "แมนยูตีเสมอจากลูกจุดโทษฟุตบอล", "กองหน้าลิเวอร์พูลยิงประตูชัย",
                "ผู้รักษาประตูแมนยูเซฟลูกฟุตบอลได้ดี", "นักเตะฟุตบอลโดนใบเหลืองสองใบ",
                "แฟนบอลลิเวอร์พูลเฮทั้งสนาม", "ฟุตบอลนัดหน้าแมนยูเจอเชลซี",
                "โค้ชลิเวอร์พูลพอใจผลฟุตบอล", "สรุปฟุตบอลลิเวอร์พูลชนะแมนยู"]
    utts = _utts(cooking + football)
    result, summary, engine = topics.analyse_topics(utts, engine="local")

    assert engine == "local"
    assert len(result) == 2
    assert result[1].utterance_ids[0] == len(cooking)
    covered = [i for t in result for i in t.utterance_ids]
    assert covered == list(range(len(utts)))
    assert all(t.title for t in result)


def test_short_transcript_is_one_topic():
    result, _, _ = topics.analyse_topics(_utts(["สวัสดี", "ดีครับ"]), engine="local")
    assert len(result) == 1 and result[0].utterance_ids == [0, 1]


def test_claude_spans_are_repaired_to_tile_transcript():
    utts = _utts([f"ประโยค {i}" for i in range(10)])
    raw = [  # out of order, overlapping, first one not starting at 0, end ids ignored
        {"title": "B", "summary": "", "key_points": [], "start_utterance_id": 4, "end_utterance_id": 9},
        {"title": "A", "summary": "", "key_points": [], "start_utterance_id": 1, "end_utterance_id": 5},
    ]
    result = topics._spans_from_claude(utts, raw)
    assert [t.title for t in result] == ["A", "B"]
    assert result[0].utterance_ids == [0, 1, 2, 3]
    assert result[1].utterance_ids == [4, 5, 6, 7, 8, 9]


def test_claude_failure_falls_back_to_local(monkeypatch):
    def boom(_):
        raise RuntimeError("no network")
    monkeypatch.setattr(topics, "_claude_topics", boom)
    result, _, engine = topics.analyse_topics(_utts(["a b", "c d"]), engine="claude")
    assert engine == "local" and len(result) == 1


def test_empty_transcript():
    assert topics.analyse_topics([], engine="local") == ([], "", "none")
