"""Render an analysis result as Markdown, SRT, plain text or JSON."""

from __future__ import annotations

import json

from .topics import fmt_time


def _srt_time(seconds: float) -> str:
    ms = int(round(seconds * 1000))
    h, ms = divmod(ms, 3_600_000)
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def to_json(result: dict) -> str:
    return json.dumps(result, ensure_ascii=False, indent=2)


def to_srt(result: dict) -> str:
    blocks = []
    for i, u in enumerate(result["utterances"], start=1):
        blocks.append(f"{i}\n{_srt_time(u['start'])} --> {_srt_time(u['end'])}\n[{u['speaker']}] {u['text']}\n")
    return "\n".join(blocks)


def to_txt(result: dict) -> str:
    return "\n".join(f"[{fmt_time(u['start'])}] {u['speaker']}: {u['text']}" for u in result["utterances"])


def to_markdown(result: dict) -> str:
    utterances = {u["id"]: u for u in result["utterances"]}
    out = [f"# {result['filename']}", ""]
    out.append(f"- ความยาว: {fmt_time(result['duration'])}")
    out.append(f"- ภาษา: {result['language']}")
    out.append(f"- จำนวนผู้พูด: {len(result['speakers'])}")
    out.append(f"- จำนวนหัวข้อ: {len(result['topics'])}")
    out.append("")
    if result.get("overall_summary"):
        out += ["## สรุปภาพรวม", "", result["overall_summary"], ""]

    out += ["## ผู้พูด", "", "| ผู้พูด | เวลาพูด | สัดส่วน | จำนวนครั้ง |", "|---|---|---|---|"]
    for s in result["speakers"]:
        out.append(f"| {s['name']} | {fmt_time(s['talk_time'])} | {s['share']}% | {s['turns']} |")
    out.append("")

    out += ["## สารบัญหัวข้อ", ""]
    for t in result["topics"]:
        out.append(f"{t['id'] + 1}. [{fmt_time(t['start'])}] {t['title']}")
    out.append("")

    for t in result["topics"]:
        out.append(f"## {t['id'] + 1}. {t['title']}  ({fmt_time(t['start'])}–{fmt_time(t['end'])})")
        out.append("")
        if t.get("summary"):
            out += [f"> {t['summary']}", ""]
        for point in t.get("key_points") or []:
            out.append(f"- {point}")
        if t.get("key_points"):
            out.append("")
        for uid in t["utterance_ids"]:
            u = utterances[uid]
            out.append(f"**{u['speaker']}** `{fmt_time(u['start'])}` {u['text']}  ")
        out.append("")
    return "\n".join(out)


FORMATS = {
    "json": (to_json, "application/json", "json"),
    "md": (to_markdown, "text/markdown", "md"),
    "srt": (to_srt, "application/x-subrip", "srt"),
    "txt": (to_txt, "text/plain", "txt"),
}
