"""FastAPI web app: upload audio, track progress, view and export results."""

from __future__ import annotations

import json
import logging
import re
import shutil
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, Response
from pydantic import BaseModel

from . import exporters, merge, pipeline
from .config import settings
from .models import Utterance

log = logging.getLogger(__name__)
STATIC_DIR = Path(__file__).parent / "static"
JOB_ID_RE = re.compile(r"^[0-9a-f]{32}$")


class JobStore:
    """Jobs live in memory while running and on disk (data/jobs/<id>/) once created."""

    def __init__(self, root: Path):
        self.root = root
        self.root.mkdir(parents=True, exist_ok=True)
        self.lock = threading.Lock()
        self.jobs: dict[str, dict] = {}
        for meta_file in self.root.glob("*/meta.json"):
            meta = json.loads(meta_file.read_text(encoding="utf-8"))
            if meta["status"] in ("queued", "running"):  # interrupted by a restart
                meta.update(status="error", error="งานถูกยกเลิกเพราะเซิร์ฟเวอร์รีสตาร์ท")
            self.jobs[meta["id"]] = meta

    def dir(self, job_id: str) -> Path:
        if not JOB_ID_RE.match(job_id):
            raise HTTPException(404, "ไม่พบงานนี้")
        return self.root / job_id

    def get(self, job_id: str) -> dict:
        self.dir(job_id)
        with self.lock:
            job = self.jobs.get(job_id)
        if job is None:
            raise HTTPException(404, "ไม่พบงานนี้")
        return job

    def save(self, job: dict) -> None:
        with self.lock:
            self.jobs[job["id"]] = job
            (self.dir(job["id"]) / "meta.json").write_text(json.dumps(job, ensure_ascii=False), encoding="utf-8")

    def update(self, job_id: str, **fields) -> None:
        with self.lock:
            job = self.jobs[job_id]
            job.update(fields)
        self.save(job)

    def result(self, job_id: str) -> dict:
        path = self.dir(job_id) / "result.json"
        if not path.exists():
            raise HTTPException(409, "งานนี้ยังประมวลผลไม่เสร็จ")
        return json.loads(path.read_text(encoding="utf-8"))

    def save_result(self, job_id: str, result: dict) -> None:
        (self.dir(job_id) / "result.json").write_text(
            json.dumps(result, ensure_ascii=False), encoding="utf-8"
        )

    def delete(self, job_id: str) -> None:
        self.get(job_id)
        with self.lock:
            self.jobs.pop(job_id, None)
        shutil.rmtree(self.dir(job_id), ignore_errors=True)


class SpeakerRename(BaseModel):
    names: dict[str, str]


def create_app(data_dir: Path | None = None, runner=pipeline.run) -> FastAPI:
    app = FastAPI(title="ระบบถอดเสียงและวิเคราะห์หัวข้อ")
    store = JobStore((data_dir or settings.data_dir) / "jobs")
    # One job at a time: the models are large and share the GPU/CPU.
    executor = ThreadPoolExecutor(max_workers=1)
    app.state.store = store

    def process(job_id: str, src: Path, filename: str, opts: pipeline.Options) -> None:
        store.update(job_id, status="running", started_at=time.time())

        def progress(stage: str, frac: float) -> None:
            store.update(job_id, stage=stage, progress=round(frac, 3))

        try:
            result = runner(src, filename, opts, progress)
            store.save_result(job_id, result.to_dict())
            store.update(job_id, status="done", progress=1.0, stage="เสร็จสิ้น", finished_at=time.time())
        except Exception as exc:
            log.exception("job %s failed", job_id)
            store.update(job_id, status="error", error=str(exc), finished_at=time.time())

    @app.get("/", response_class=HTMLResponse)
    def index():
        return (STATIC_DIR / "index.html").read_text(encoding="utf-8")

    @app.get("/api/health")
    def health():
        from .topics import _claude_available

        return {
            "whisper_model": settings.whisper_model,
            "diarization": bool(settings.hf_token),
            "claude": _claude_available(),
        }

    @app.post("/api/jobs")
    async def create_job(
        file: UploadFile = File(...),
        language: str = Form(""),
        num_speakers: int | None = Form(None),
        min_speakers: int | None = Form(None),
        max_speakers: int | None = Form(None),
        diarize: bool = Form(True),
        topic_engine: str = Form("auto"),
        whisper_model: str = Form(""),
    ):
        if topic_engine not in ("auto", "claude", "local"):
            raise HTTPException(400, "topic_engine ต้องเป็น auto, claude หรือ local")
        job_id = uuid.uuid4().hex
        job_dir = store.dir(job_id)
        job_dir.mkdir(parents=True)
        filename = Path(file.filename or "audio").name
        suffix = Path(filename).suffix.lower()[:10] or ".bin"
        src = job_dir / f"source{suffix}"
        with src.open("wb") as fh:
            shutil.copyfileobj(file.file, fh)

        opts = pipeline.Options(
            language=language or None,
            num_speakers=num_speakers or None,
            min_speakers=min_speakers or None,
            max_speakers=max_speakers or None,
            diarize=diarize,
            topic_engine=topic_engine,
            whisper_model=whisper_model or None,
        )
        store.save(
            {
                "id": job_id, "filename": filename, "source": src.name, "status": "queued",
                "stage": "รอคิว", "progress": 0.0, "created_at": time.time(), "error": None,
            }
        )
        executor.submit(process, job_id, src, filename, opts)
        return store.get(job_id)

    @app.get("/api/jobs")
    def list_jobs():
        with store.lock:
            jobs = list(store.jobs.values())
        return sorted(jobs, key=lambda j: -j["created_at"])

    @app.get("/api/jobs/{job_id}")
    def get_job(job_id: str):
        job = dict(store.get(job_id))
        if job["status"] == "done":
            job["result"] = store.result(job_id)
        return job

    @app.get("/api/jobs/{job_id}/audio")
    def get_audio(job_id: str):
        job = store.get(job_id)
        return FileResponse(store.dir(job_id) / job["source"])

    @app.get("/api/jobs/{job_id}/export/{fmt}")
    def export(job_id: str, fmt: str):
        if fmt not in exporters.FORMATS:
            raise HTTPException(400, f"รองรับเฉพาะ: {', '.join(exporters.FORMATS)}")
        render, media_type, ext = exporters.FORMATS[fmt]
        job = store.get(job_id)
        body = render(store.result(job_id))
        stem = Path(job["filename"]).stem or "transcript"
        return Response(
            body,
            media_type=f"{media_type}; charset=utf-8",
            headers={"Content-Disposition": f"attachment; filename*=UTF-8''{_quote(stem)}.{ext}"},
        )

    @app.patch("/api/jobs/{job_id}/speakers")
    def rename_speakers(job_id: str, body: SpeakerRename):
        result = store.result(job_id)
        names = {old: new.strip() for old, new in body.names.items() if new.strip()}
        for u in result["utterances"]:
            u["speaker"] = names.get(u["speaker"], u["speaker"])
        # Recomputed so that renaming two labels to one name merges them.
        result["speakers"] = merge.speaker_stats([Utterance(**u) for u in result["utterances"]])
        for t in result["topics"]:
            t["speakers"] = list(dict.fromkeys(names.get(s, s) for s in t["speakers"]))
        store.save_result(job_id, result)
        return result

    @app.delete("/api/jobs/{job_id}")
    def delete_job(job_id: str):
        if store.get(job_id)["status"] in ("queued", "running"):
            raise HTTPException(409, "ลบงานที่กำลังประมวลผลไม่ได้")
        store.delete(job_id)
        return {"ok": True}

    return app


def _quote(text: str) -> str:
    from urllib.parse import quote

    return quote(text, safe="")
