import time

from fastapi.testclient import TestClient

from audio_analyzer.app import create_app
from audio_analyzer.models import AnalysisResult, Topic, Utterance


def fake_runner(src, filename, opts, progress):
    progress("กำลังถอดเสียงเป็นข้อความ", 0.5)
    utts = [Utterance(0, 0.0, 2.0, "ผู้พูด 1", "สวัสดีครับ"), Utterance(1, 2.5, 4.0, "ผู้พูด 2", "สวัสดีค่ะ")]
    return AnalysisResult(
        filename=filename, language=opts.language or "th", duration=4.0,
        speakers=[{"name": "ผู้พูด 1", "talk_time": 2.0, "turns": 1, "share": 57.1},
                  {"name": "ผู้พูด 2", "talk_time": 1.5, "turns": 1, "share": 42.9}],
        utterances=utts,
        topics=[Topic(0, "ทักทาย", "ทั้งสองคนทักทายกัน", 0.0, 4.0, [0, 1], ["ทักทาย"], ["ผู้พูด 1", "ผู้พูด 2"])],
        engines={"transcription": "fake", "diarization": "fake", "topics": "fake", "notes": []},
    )


def wait_done(client, job_id):
    for _ in range(100):
        job = client.get(f"/api/jobs/{job_id}").json()
        if job["status"] in ("done", "error"):
            return job
        time.sleep(0.05)
    raise AssertionError("job did not finish")


def test_full_job_lifecycle(tmp_path):
    client = TestClient(create_app(data_dir=tmp_path, runner=fake_runner))
    assert "อัปโหลดไฟล์เสียง" in client.get("/").text

    r = client.post("/api/jobs", files={"file": ("ประชุม.mp3", b"fake-audio", "audio/mpeg")}, data={"language": "th"})
    assert r.status_code == 200
    job = wait_done(client, r.json()["id"])
    assert job["status"] == "done", job
    assert job["result"]["topics"][0]["title"] == "ทักทาย"

    assert client.get(f"/api/jobs/{job['id']}/audio").content == b"fake-audio"

    md = client.get(f"/api/jobs/{job['id']}/export/md")
    assert "## 1. ทักทาย" in md.text and "filename*=UTF-8''" in md.headers["content-disposition"]
    srt = client.get(f"/api/jobs/{job['id']}/export/srt").text
    assert "00:00:00,000 --> 00:00:02,000" in srt and "[ผู้พูด 2] สวัสดีค่ะ" in srt
    assert client.get(f"/api/jobs/{job['id']}/export/pdf").status_code == 400

    # renaming both speakers to the same name merges them
    merged = client.patch(f"/api/jobs/{job['id']}/speakers",
                          json={"names": {"ผู้พูด 1": "คุณเอ", "ผู้พูด 2": "คุณเอ"}}).json()
    assert [s["name"] for s in merged["speakers"]] == ["คุณเอ"]
    assert merged["topics"][0]["speakers"] == ["คุณเอ"]

    # results survive an app restart
    client2 = TestClient(create_app(data_dir=tmp_path, runner=fake_runner))
    assert client2.get(f"/api/jobs/{job['id']}").json()["result"]["speakers"][0]["name"] == "คุณเอ"

    assert client.delete(f"/api/jobs/{job['id']}").json() == {"ok": True}
    assert client.get(f"/api/jobs/{job['id']}").status_code == 404


def test_failed_job_reports_error(tmp_path):
    def broken(*_):
        raise RuntimeError("แปลงไฟล์เสียงไม่สำเร็จ")
    client = TestClient(create_app(data_dir=tmp_path, runner=broken))
    job_id = client.post("/api/jobs", files={"file": ("x.wav", b"x")}).json()["id"]
    job = wait_done(client, job_id)
    assert job["status"] == "error" and "แปลงไฟล์" in job["error"]


def test_rejects_bad_ids_and_options(tmp_path):
    client = TestClient(create_app(data_dir=tmp_path, runner=fake_runner))
    assert client.get("/api/jobs/../../etc").status_code == 404
    assert client.get("/api/jobs/" + "z" * 32).status_code == 404
    r = client.post("/api/jobs", files={"file": ("x.wav", b"x")}, data={"topic_engine": "gpt"})
    assert r.status_code == 400
