#!/usr/bin/env python3
"""
Cantonese.ai Voice Cloning CLI
用法: python clone_voice.py sample.wav --name "我把聲"

⚠️ 注意: create-voice endpoint 用 session 認證，唔係 API key。
你要先喺瀏覽器 login 到 cantonese.ai，攞 session cookie，
或者用 cantonese.ai 嗰邊提供嘅 OAuth flow。
目前個 script 會試 API key 認證先，如果 fail 再提示點樣用 cookie。
"""
import argparse
import os
import sys
from pathlib import Path

import requests

API_URL = "https://cantonese.ai/api/voices"  # 路徑請根據最新 docs 確認


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


def clone(args) -> None:
    sample_path = Path(args.sample).resolve()
    if not sample_path.exists():
        sys.exit(f"❌ 搵唔到檔案: {sample_path}")

    size_mb = sample_path.stat().st_size / 1024 / 1024
    if size_mb > 50:
        sys.exit(f"❌ 檔案太大 ({size_mb:.1f} MB)，通常要 <50 MB")

    print(f"→ 上傳緊 {sample_path.name} ({size_mb:.2f} MB)...")

    api_key = load_api_key()
    session = args.session_cookie or os.environ.get("CANTONESE_AI_SESSION")

    headers = {}
    cookies = {}
    if session:
        cookies["session"] = session
    else:
        # 後備試 API key (可能唔得，睇 docs)
        headers["Authorization"] = f"Bearer {api_key}"

    data = {
        "name": args.name,
        "language": args.language,
        "gender": args.gender,
        "age": args.age,
    }
    if args.description:
        data["description"] = args.description

    with open(sample_path, "rb") as f:
        files = {"data": (sample_path.name, f, "audio/wav")}
        try:
            resp = requests.post(
                API_URL,
                headers=headers,
                cookies=cookies,
                data=data,
                files=files,
                timeout=180,
            )
        except requests.exceptions.RequestException as e:
            sys.exit(f"❌ 網絡錯誤: {e}")

    if resp.status_code == 401:
        sys.exit(
            "❌ 401 — Create Voice endpoint 要 session cookie 認證。\n"
            "   步驟: 1) 去 cantonese.ai login\n"
            "         2) DevTools → Application → Cookies → 抄 session value\n"
            "         3) export CANTONESE_AI_SESSION='抄過嚟嘅值'\n"
            "         或用 --session-cookie 'xxx' flag"
        )
    if resp.status_code == 403:
        sys.exit("❌ 403 — Custom voice quota 滿咗，要升級 TTS plan。")
    if resp.status_code == 400:
        sys.exit(f"❌ 400 — {resp.text[:300]}\n(通常係音檔太短/太長，或聽唔到清晰人聲)")
    if resp.status_code >= 400:
        sys.exit(f"❌ HTTP {resp.status_code}: {resp.text[:500]}")

    result = resp.json()
    if not result.get("success"):
        sys.exit(f"❌ 失敗: {result}")

    voice_id = result["voice_id"]
    print(f"✓ 成功！")
    print(f"  voice_id: {voice_id}")
    print(f"\n  之後用呢條去做 TTS:")
    print(f'  python tts.py "你要講嘅嘢" --voice-id {voice_id}')


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Cantonese.ai 聲線克隆")
    p.add_argument("sample", help="音樣檔案路徑 (wav/mp3)")
    p.add_argument("--name", required=True, help="呢把聲嘅名")
    p.add_argument("--language", default="cantonese")
    p.add_argument(
        "--gender",
        choices=["male", "female", "unknown"],
        default="unknown",
    )
    p.add_argument(
        "--age",
        choices=["youth", "young_adult", "adult", "middle_aged", "senior", "unknown"],
        default="unknown",
    )
    p.add_argument("--description", help="可選描述")
    p.add_argument("--session-cookie", help="session cookie (優先過 env var)")
    return p


def main():
    clone(build_parser().parse_args())


if __name__ == "__main__":
    main()
