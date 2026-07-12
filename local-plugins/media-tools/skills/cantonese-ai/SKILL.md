---
name: cantonese-ai
description: Cantonese.ai TTS integration for Claude Code. Use this skill whenever the user wants to generate Cantonese speech, clone a voice, or convert text/Jyutping to audio via Cantonese.ai. Triggers on phrases like "cantonese tts", "講粵語", "做把聲", "voice clone", "轉粵拼做聲", "read this in cantonese", or any time the user references a cantonese.ai voice_id. Supports text input AND Jyutping input, custom cloned voices, and the private-tier V6 model.
---

# Cantonese.ai TTS Skill

Wrapper around `https://cantonese.ai/api` for Claude Code agentic workflows.

The helper scripts are bundled in this skill's `scripts/` directory — resolve their path relative to this SKILL.md file (in a plugin install, that is `<plugin-cache-dir>/skills/cantonese-ai/scripts/`).

## What it does
1. **TTS** — text or Jyutping → `.wav` / `.mp3`
2. **Voice cloning** — upload a sample → get back a `voice_id` for reuse
3. **Jyutping helper** — convert Chinese text to Jyutping before feeding TTS (useful for rare chars / pronunciation override)

## Prerequisites
```bash
# One-time setup
pip install requests python-dotenv --break-system-packages
export CANTONESE_AI_API_KEY="sk-..."   # or put it in ~/.cantonese-ai.env
```

⚠️ **Never hardcode the key.** The scripts read from env vars only.

## Quick commands

### 1. Text → speech (default voice)
```bash
python scripts/tts.py "你今日食咗飯未？" -o output.wav
```

### 2. Text → speech with cloned voice + V6 private model
```bash
python scripts/tts.py "歡迎嚟到我嘅頻道" \
  --voice-id 2725cf0f-efe2-4132-9e06-62ad84b2973d \
  --model v6 \
  --output intro.wav
```

### 3. Jyutping input → speech
```bash
python scripts/tts.py "nei5 hou2 maa3" --input-type jyutping -o hello.wav
```

### 4. Clone a new voice from a sample
```bash
python scripts/clone_voice.py ./my_sample.wav \
  --name "Hugo casual" --gender male --age young_adult
# → prints new voice_id, save it
```

### 5. Convert text to Jyutping (useful for tuning pronunciation)
```bash
python scripts/jyutping.py "今日天氣好靚"
# → gam1 jat6 tin1 hei3 hou2 leng3
```

## Parameters reference

| Flag | Default | Notes |
|---|---|---|
| `--voice-id` | system default | UUID from voice library or your clones |
| `--input-type` | `text` | `text` or `jyutping` |
| `--model` | `v6` | V6 is the private-tier high-quality model. Account must be on private pricing. |
| `--speed` | `1.0` | 0.5 – 3.0 |
| `--pitch` | `0` | -12 to +12 semitones |
| `--frame-rate` | `24000` | 16000 / 24000 / 44100 |
| `--output` | `output.wav` | `.wav` or `.mp3` |
| `--timestamps` | off | Returns SRT + word-level JSON |
| `--enhance` | off | Audio post-processing |

## Notes on V6 + Private Pricing

The public API docs (`docs.cantonese.ai/text-to-speech`) do **not** publish a `model` parameter. Based on how cantonese.ai structures their pricing:

- **Private pricing is tied to your API key**, not a request param. If your key is provisioned for the private tier, you just use it — the pricing auto-applies.
- **V6 access is likely gated by the voice_id** (certain voice IDs are V6-only) or by a param like `model` / `model_version` that the vendor will confirm on request.

`tts.py` sends `model` in the JSON body as a forward-compatible extra field. If the server ignores unknown fields (common), it just works once they flip the flag on your account. If V6 needs a different param name, edit `MODEL_PARAM_NAME` at the top of `tts.py`.

## For Claude agents

When a user asks to "say this in Cantonese" or drops a voice_id, Claude should:

1. Check `CANTONESE_AI_API_KEY` is set; if not, tell user to export it
2. Decide input type from context (Chinese chars → `text`, ASCII with tone numbers → `jyutping`)
3. Run `python <skill-dir>/scripts/tts.py "<text>" [flags]` (write output files to the current working directory, not the skill dir)
4. Report back the output file path and duration

For voice cloning, always ask the user to confirm the sample file path before uploading — it's a destructive (quota-using) action.
