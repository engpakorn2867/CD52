# CD52 — ระบบถอดเสียง แยกผู้พูด และแยกหัวข้อ

เว็บแอปสำหรับอัปโหลดคลิปเสียงหรือวิดีโอ ระบบจะทำงานให้ 3 อย่าง:

1. **ถอดเสียงเป็นข้อความ** ด้วย [faster-whisper](https://github.com/SYSTRAN/faster-whisper) (Whisper large-v3 รองรับภาษาไทย) ทำงานในเครื่อง
2. **แยกผู้พูด** (ใครพูดตอนไหน) ด้วย [pyannote.audio](https://github.com/pyannote/pyannote-audio) ทำงานในเครื่อง
3. **แยกหัวข้อ** ทั้งหมดในคลิป พร้อมชื่อหัวข้อ เวลาเริ่มและจบ ผู้พูดในแต่ละหัวข้อ และสรุป
   - แบบออฟไลน์ (ค่าเริ่มต้น): แบ่งช่วงตามความคล้ายของเนื้อหา และตั้งชื่อหัวข้อจากคำสำคัญ
   - แบบ Claude (ไม่บังคับ): ตั้งชื่อหัวข้อเป็นภาษาธรรมชาติ สรุปแต่ละหัวข้อ ประเด็นสำคัญ และสรุปภาพรวม
     ⚠️ โหมดนี้ส่ง **ข้อความถอดเสียง** (ไม่ใช่ไฟล์เสียง) ไปยัง Anthropic API

หน้าเว็บทำอะไรได้บ้าง: มีเครื่องเล่นเสียง คลิกเวลาหรือหัวข้อแล้วกระโดดไปฟังจุดนั้นได้ ประโยคที่กำลังเล่นจะไฮไลต์ ค้นหาในบทสนทนาได้ เปลี่ยนชื่อผู้พูดได้ (ตั้งชื่อซ้ำกันเพื่อรวมผู้พูดที่ระบบแยกผิด) และดาวน์โหลดผลเป็น Markdown, TXT, SRT (ซับไตเติล) หรือ JSON

## ติดตั้ง

ต้องมี Python 3.10 ขึ้นไป และ ffmpeg

```bash
# ffmpeg: sudo apt install ffmpeg   หรือ   brew install ffmpeg
python -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

ถ้ามีการ์ดจอ NVIDIA ให้ติดตั้ง PyTorch รุ่น CUDA ตาม [pytorch.org](https://pytorch.org) จะเร็วขึ้นมาก ถ้ารันบน CPU ก็ใช้ได้แต่ช้ากว่า
(คลิป 1 ชั่วโมงบน CPU ใช้เวลาประมาณ 30–60 นาที ถ้าต้องการให้เร็วขึ้นให้ใช้ `WHISPER_MODEL=small`)

### เปิดใช้การแยกผู้พูด (ทำครั้งเดียว)

1. สมัครบัญชี [huggingface.co](https://huggingface.co) แล้วสร้าง Access Token (สิทธิ์ read)
2. เข้าไปกด "Agree" เงื่อนไขการใช้โมเดลทั้งสองหน้า
   - https://huggingface.co/pyannote/speaker-diarization-3.1
   - https://huggingface.co/pyannote/segmentation-3.0
3. ตั้งค่าตัวแปร `HF_TOKEN=hf_xxx`

ถ้าไม่ตั้งค่า ระบบจะยังถอดเสียงและแยกหัวข้อได้ตามปกติ แต่ทุกประโยคจะเป็น "ผู้พูด 1" ทั้งหมด

### เปิดใช้ Claude สำหรับวิเคราะห์หัวข้อ (ไม่บังคับ)

ตั้งค่า `ANTHROPIC_API_KEY=sk-ant-xxx` เมื่อตั้งแล้ว โหมด "อัตโนมัติ" จะเลือกใช้ Claude ให้เอง ถ้าเรียก Claude ไม่สำเร็จ ระบบจะกลับไปใช้แบบออฟไลน์แทน

## เริ่มใช้งาน

```bash
export HF_TOKEN=hf_xxx                 # ไม่บังคับ
export ANTHROPIC_API_KEY=sk-ant-xxx    # ไม่บังคับ
python -m audio_analyzer               # เปิด http://127.0.0.1:8000
```

ครั้งแรกระบบจะดาวน์โหลดโมเดล (Whisper large-v3-turbo ประมาณ 1.6 GB) ครั้งถัดไปไม่ต้องโหลดอีก

## ตั้งค่าเพิ่มเติม (ตัวแปร environment)

| ตัวแปร | ค่าเริ่มต้น | ความหมาย |
|---|---|---|
| `WHISPER_MODEL` | `large-v3-turbo` | `large-v3` แม่นที่สุด, `small` / `medium` เร็วกว่า |
| `DEVICE` | `auto` | `cuda` หรือ `cpu` |
| `HF_TOKEN` | – | ใช้สำหรับการแยกผู้พูด |
| `DIARIZATION_MODEL` | `pyannote/speaker-diarization-3.1` | |
| `TOPIC_ENGINE` | `auto` | `claude` หรือ `local` |
| `CLAUDE_MODEL` | `claude-opus-5-5` | |
| `DATA_DIR` | `data` | โฟลเดอร์เก็บไฟล์ที่อัปโหลดและผลลัพธ์ |

## API

| Method | Path | |
|---|---|---|
| POST | `/api/jobs` | อัปโหลด (multipart: `file`, `language`, `num_speakers`, `min_speakers`, `max_speakers`, `diarize`, `topic_engine`, `whisper_model`) |
| GET | `/api/jobs` | ดูรายการงานทั้งหมด |
| GET | `/api/jobs/{id}` | ดูสถานะ/ความคืบหน้า และผลลัพธ์เมื่อทำเสร็จ |
| GET | `/api/jobs/{id}/export/{md,txt,srt,json}` | ดาวน์โหลดผลลัพธ์ |
| PATCH | `/api/jobs/{id}/speakers` | เปลี่ยนชื่อผู้พูด `{"names": {"ผู้พูด 1": "คุณสมชาย"}}` |
| DELETE | `/api/jobs/{id}` | ลบงานและไฟล์ |

## โครงสร้างโค้ด

```
audio_analyzer/
  audio.py       แปลงไฟล์เป็น WAV 16kHz mono ด้วย ffmpeg
  transcribe.py  ถอดเสียง (faster-whisper พร้อม timestamp ระดับคำ)
  diarize.py     แยกผู้พูด (pyannote)
  merge.py       จับคู่คำกับผู้พูดและรวมเป็นประโยค พร้อมสถิติเวลาพูด
  topics.py      แยกหัวข้อ (Claude หรือ TextTiling แบบออฟไลน์)
  exporters.py   ส่งออกเป็น Markdown / SRT / TXT / JSON
  pipeline.py    รวมทุกขั้นตอน
  app.py         เว็บเซิร์ฟเวอร์ FastAPI
  static/        หน้าเว็บ
```

## ทดสอบ

```bash
pip install -r requirements-dev.txt
pytest
```
