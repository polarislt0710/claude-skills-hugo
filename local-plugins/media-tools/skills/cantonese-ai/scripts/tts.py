#!/usr/bin/env python3
"""
Cantonese.ai TTS CLI
用法: python tts.py "你好" [flags]

讀 CANTONESE_AI_API_KEY 環境變數，絕不會喺參數或 code 度出現條 key。
"""
import argparse
import base64
import json
import os
import sys
from pathlib import Path

import requests

API_URL = "https://cantonese.ai/api/tts"

# 如果 cantonese.ai 後面改咗 param 名，喺呢度改一個字就得
MODEL_PARAM_NAME = "model"          # 有可能係 "model_version"
INPUT_TYPE_PARAM_NAME = "input_type"
JYUTPING_PARAM_NAME = "jyutping" # 有可能係 "text_format"


def load_api_key() -> str:
    key = os.environ.get("CANTONESE_AI_API_KEY")
    if not key:
        # 試下 ~/.cantonese-ai.env
        env_file = Path.home() / ".cantonese-ai.env"
        if env_file.exists():
            for line in env_file.read_text().splitlines():
                if line.startswith("CANTONESE_AI_API_KEY="):
                    key = line.split("=", 1)[1].strip().strip('"').strip("'")
                    break
    if not key:
        sys.exit(
            "❌ 搵唔到 API key。請設 export CANTONESE_AI_API_KEY=sk-... "
            "或者喺 ~/.cantonese-ai.env 寫低。"
        )
    return key


def synthesize(args) -> None:
    api_key = load_api_key()

    output_ext = args.output.split(".")[-1].lower()
    if output_ext not in ("wav", "mp3"):
        sys.exit(f"❌ 唔支援嘅格式: .{output_ext}（只支援 wav / mp3）")

    payload = {
        "api_key": api_key,
        "text": args.text,
        "frame_rate": str(args.frame_rate),
        "speed": args.speed,
        "pitch": args.pitch,
        "language": args.language,
        "output_extension": output_ext,
        "should_enhance": args.enhance,
        "should_convert_from_simplified_to_traditional": args.s2t,
        "should_return_timestamp": args.timestamps,
        "should_use_turbo_model": args.turbo,
    }

    if args.voice_id:
        payload["voice_id"] = args.voice_id

    # V6 / private-tier 用嘅 model flag (forward-compatible)
    if args.model:
        payload[MODEL_PARAM_NAME] = args.model

    # 粵拼輸入 — 俾個 hint 落去，如果 server 唔識會自動忽略
    if args.input_type == "jyutping":
        payload[INPUT_TYPE_PARAM_NAME] = "jyutping"

    if args.jyutping:
        payload[JYUTPING_PARAM_NAME] = args.jyutping

    if args.duration:
        payload["duration"] = args.duration

    if args.verbose:
        safe_payload = {**payload, "api_key": "sk-***REDACTED***"}
        print(f"→ POST {API_URL}", file=sys.stderr)
        print(json.dumps(safe_payload, ensure_ascii=False, indent=2), file=sys.stderr)

    try:
        resp = requests.post(API_URL, json=payload, timeout=120)
    except requests.exceptions.Timeout:
        sys.exit("❌ 等超過 120 秒，server 可能塞咗車，遲啲再試。")
    except requests.exceptions.RequestException as e:
        sys.exit(f"❌ 網絡錯誤: {e}")

    if resp.status_code == 401:
        sys.exit("❌ API key 無效或過期。去 cantonese.ai/api-keys 確認一下。")
    if resp.status_code == 403:
        sys.exit(
            "❌ 403 Forbidden — 你條 key 可能冇 private/V6 嘅權限，"
            "或者指定嗰個 voice_id 唔屬於你。"
        )
    if resp.status_code == 413:
        sys.exit("❌ 文字太長（>5000 字），斬短佢再試。")
    if resp.status_code == 429:
        sys.exit("❌ Rate limit hit，等陣再試。")
    if resp.status_code >= 400:
        sys.exit(f"❌ HTTP {resp.status_code}: {resp.text[:500]}")

    out_path = Path(args.output).resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)

    if args.timestamps:
        data = resp.json()
        audio_bytes = base64.b64decode(data["file"])
        out_path.write_bytes(audio_bytes)

        srt_path = out_path.with_suffix(".srt")
        srt_path.write_text(data.get("srt_timestamp", ""), encoding="utf-8")

        ts_path = out_path.with_suffix(".timestamps.json")
        ts_path.write_text(
            json.dumps(data.get("timestamps", []), ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

        size_kb = len(audio_bytes) / 1024
        print(f"✓ 音頻: {out_path} ({size_kb:.1f} KB)")
        print(f"✓ SRT:  {srt_path}")
        print(f"✓ 時間戳: {ts_path}")
        print(f"  request_id: {data.get('request_id', 'n/a')}")
    else:
        out_path.write_bytes(resp.content)
        size_kb = len(resp.content) / 1024
        print(f"✓ 生成完成: {out_path} ({size_kb:.1f} KB)")


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description="Cantonese.ai TTS CLI (V6-ready, 支援粵拼輸入)",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p.add_argument("text", help="要講嘅文字（中文）或者粵拼")
    p.add_argument("-o", "--output", default="output.wav", help="輸出檔案路徑 (.wav/.mp3)")

    p.add_argument(
        "--voice-id",
        help="Voice UUID，cantonese.ai/voices 攞。唔填就用預設聲。",
    )
    p.add_argument(
        "--input-type",
        choices=["text", "jyutping"],
        default="text",
        help="輸入類型：text (中文) 或 jyutping (粵拼，如 nei5 hou2)",
    )
    p.add_argument(
        "--model",
        default="v6",
        help="Model 版本，private tier 用 v6。設 --model '' 去 fallback 去公開預設。",
    )

    p.add_argument("--jyutping", help="V6: send jyutping for pronunciation")
    p.add_argument("--speed", type=float, default=1.0, help="0.5–3.0")
    p.add_argument("--pitch", type=float, default=0, help="-12 到 +12 半音")
    p.add_argument("--duration", type=float, help="目標時長（秒）")
    p.add_argument("--frame-rate", type=int, default=24000, choices=[16000, 24000, 44100])
    p.add_argument(
        "--language",
        default="cantonese",
        choices=["cantonese", "english", "mandarin"],
    )

    p.add_argument("--enhance", action="store_true", help="加強音質後處理")
    p.add_argument("--s2t", action="store_true", help="簡體轉繁體")
    p.add_argument("--timestamps", action="store_true", help="同時輸出 SRT + word-level JSON")
    p.add_argument("--turbo", action="store_true", help="用 turbo 模型（更快，質素略降）")

    p.add_argument("-v", "--verbose", action="store_true", help="印 request payload (key 會 redact)")

    return p


def main():
    args = build_parser().parse_args()
    synthesize(args)


if __name__ == "__main__":
    main()
