---
name: kimi-delegate
description: Delegate ONE focused task to Kimi (kimi-k3-thinking via Hugo's proxy) and return its answer. Use when Hugo says "叫 Kimi", "ask Kimi", "Kimi 睇下", "用 Kimi 出 plan/意見", or when a task benefits from Kimi's perspective (research, frontend/UX opinions, long-document reading up to ~1M tokens, second opinions). NOT for multi-step agentic coding — Kimi here is a one-shot advisor, not an executor.
---

# Kimi Delegate — one-shot, chopped tasks only

Call Kimi through the bundled script. Each invocation is a **stateless one-shot session** — that is
deliberate and must be preserved (Hugo's instruction: 斬件、單開一次).

## How to call

```bash
node "$(dirname "$SKILL_PATH")/scripts/kimi-call.mjs" --max-tokens 8000 "<the single focused task>"
```

- Prompt via argv, or pipe long input via stdin with `--stdin` (put the instruction in `--system`).
- `--system "<role>"` — optional system prompt (e.g. 你係前端/UX 顧問，用廣東話答).
- `--max-tokens N` — default 8000. Kimi k3 is a THINKING model: reasoning eats tokens first, so
  never set this low; if output comes back empty with finish=length, double it.
- `--timeout-ms` default 300000, `--retries` default 3 (auto-reconnect with backoff — the proxy
  drops connections regularly; the script handles rejoining, you do not need to).
- `--json` for the raw API response; `--show-reasoning` to also print the reasoning trace.

## Hard rules (from Hugo, 2026-07-23)

1. **One focused task per call.** Never batch ("write a plan AND split it AND decide") — chop first.
2. **Plan → NEW session → decisions.** If Kimi wrote a plan, END there. Make decisions yourself or
   start a fresh kimi-call to chop the plan. Never continue a conversation — there is no session.
3. **Expect slowness** (~20s+ for short answers, minutes for long ones). Run it and wait; do not
   parallel-spam the proxy with many calls at once.
4. **Context window ~1M tokens** — long documents are fine as stdin input, but do not stuff
   irrelevant context.
5. **Secrets**: credentials live in `~/.kimi_secrets` (0600). NEVER print, log, or commit the key.
   If the file is missing, tell Hugo — do not ask for the key in chat.

## Honesty note

The proxy self-reports backend model `zai-org/GLM-5.2` while the persona claims Kimi k3
(verified 2026-07-23). Treat output quality accordingly and do not present its answers as
authoritative Kimi-official behavior. Hugo knows.

## Role guidance (Hugo's division of labor)

Kimi = 研究員 / 多角度意見 / frontend & UX eye. Coding stays with Codex (gpt-5.6-sol hard,
gpt-5.6-terra easy); planning/review with Opus. Use Kimi for: research digests, alternative
perspectives on a plan, frontend/UX critique, long-document summarization.
