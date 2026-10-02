"""Run the web app: python -m audio_analyzer [--host 0.0.0.0] [--port 8000]"""

import argparse
import logging

import uvicorn


def main() -> None:
    parser = argparse.ArgumentParser(description="ระบบถอดเสียง แยกผู้พูด และแยกหัวข้อ")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO)
    uvicorn.run("audio_analyzer.app:create_app", factory=True, host=args.host, port=args.port)


if __name__ == "__main__":
    main()
