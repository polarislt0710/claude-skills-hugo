#!/usr/bin/env python3
"""
文字 → 粵拼 轉換器
用法: python jyutping.py "今日天氣好靚"
"""
import argparse
import os
import sys
from pathlib import Path

import requests

API_URL = "https://cantonese.ai/api/text-to-jyutping"


def load_api_key() -> str:
    key = os.environ.get("CANTONESE_AI_API_KEY")
    if not key:
        env_file = Path.home() / ".cantonese-ai.env"
        if env_file.exists():
            for line in env_file.read_text().splitlines():
                if line.startswith("CANTONESE_AI_API_KEY="):
                    key = line.split("=", 1)[1].strip().strip('"').strip("'")
                    break
    if not key:
        sys.exit("❌ 搵唔到 CANTONESE_AI_API_KEY")
    return key


def convert(text: str, raw: bool = False) -> None:
    payload = {"api_key": load_api_key(), "text": text}
    try:
        resp = requests.post(API_URL, json=payload, timeout=30)
    except requests.exceptions.RequestException as e:
        sys.exit(f"❌ 網絡錯誤: {e}")

    if resp.status_code >= 400:
        sys.exit(f"❌ HTTP {resp.status_code}: {resp.text[:300]}")

    data = resp.json()
    if raw:
        import json as _json
        print(_json.dumps(data, ensure_ascii=False, indent=2))
    else:
        # Docs 未定 response shape，打幾個 common key 睇下
        for key in ("jyutping", "result", "text", "output"):
            if key in data:
                print(data[key])
                return
        print(data)


def main():
    p = argparse.ArgumentParser(description="中文 → 粵拼")
    p.add_argument("text", help="要轉嘅中文")
    p.add_argument("--raw", action="store_true", help="印完整 JSON")
    args = p.parse_args()
    convert(args.text, args.raw)


if __name__ == "__main__":
    main()
