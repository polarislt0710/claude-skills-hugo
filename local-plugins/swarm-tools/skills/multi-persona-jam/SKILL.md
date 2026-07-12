---
name: multi-persona-jam
description: Orchestrate a multi-persona stakeholder design jam with real-time WebSocket visualization. 5 phases (Position → Cross-Exam → Rebuttal → Revision → Synthesis) with live updates streamed to the swarm dashboard (default http://187.127.115.235:3010, override with SWARM_DASHBOARD_URL — open a second browser tab to watch the live graph). Activate when user says "用 N 個 persona/角度 jam/分析 X" / "stakeholder jam" / "multi-persona analyze X" / "swarm <topic>". Personas can be auto-suggested or explicitly listed.
---

# Multi-Persona Stakeholder Jam

Run a 5-phase swarm with genuine multi-round debate:

1. **Position** — each persona writes a substantive position paper (parallel sub-agents)
2. **Cross-Examination** — contentious pairs do 3 rounds of real back-and-forth (sub-agents)
3. **Rebuttal** — each persona reviews all attacks and writes a defence (parallel sub-agents)
4. **Revision** — each persona revises their position based on what they learned (parallel sub-agents)
5. **Synthesis** — structured convergence citing debate outcomes

Two bundled references do the heavy lifting — read them when you reach the relevant phase:
- **[references/phase-templates.md](references/phase-templates.md)** — copy-paste sub-agent prompt templates for Phases 1-4, the rethink prompt, and the Phase 5 synthesis structure
- **[references/dashboard-events.md](references/dashboard-events.md)** — event payload specs, JSON escaping, pacing

## Emitting dashboard events

Use the bundled helper (resolve `<skill-dir>` = the directory containing this SKILL.md):

```bash
bash "<skill-dir>/scripts/emit-event.sh" <event-type> '<json-payload>'
# multi-line content: printf '%s' "$CONTENT" | jq -Rs '{agent:"校長", content:.}' \
#   | bash "<skill-dir>/scripts/emit-event.sh" agent-proposal -
```

The script reads `SWARM_DASHBOARD_URL` (default baked in) and **never fails the jam** — if the dashboard is down it warns once and exits 0. Keep going without visualization.

## Phase 0: Setup

1. Identify **TOPIC** from the user prompt
2. Identify **PERSONAS**:
   - **Explicit list** in prompt (e.g. "用校長/老師/科主任/學生/研發者") → use those exactly
   - **No list** / "default" → propose 5-7 sensible personas, **ASK user to confirm**
3. Confirm with one-liner: `🌀 Jam topic: X | Personas: [...] | OK?` — wait for "go" / "ok" / "yes"
4. Emit `swarm-start` with `{"topic":"<TOPIC>","personas":["P1","P2",...]}`

## Phase 1: Position Paper

**Spawn ALL persona sub-agents in ONE message** (parallel, not serial) — `Agent` tool, `subagent_type: "general-purpose"`, using the **Position Paper template** (in phase-templates.md). The template enforces the language rules: everyday Cantonese for non-technical personas, no buzzwords, specific > abstract, 500-800 字, fixed `###` section structure (立場 / 最關心 3 件事 / 底線 / 妥協範圍 / 對其他角色嘅預判).

After ALL return: emit one `agent-proposal` per persona.

## Phase 2: Cross-Examination

The core innovation — genuine multi-round debates instead of shallow one-line critiques.

1. **Identify contentious pairs** from Phase 1 outputs — look for contradictory bottom lines, resource competition, values clashes. Rank by irreconcilability; pick the top **3-4 pairs**.
2. **Run debates**: for each pair spawn ONE sub-agent with the **Debate template** — it simulates a full 3-round cross-examination (開場質詢 → 深入追問 → 最終交鋒) and returns structured JSON (rounds/exchanges/unresolved/surprise).
3. **Emit events**: parse each JSON; for every exchange POST a `debate-message` with content prefixed `【第 <round> 回合 — <label>】`. Pace **0.5-0.8s** between POSTs so the animation is watchable.
4. **Remaining pairs**: generate a single quick critique each direction (inline, 2-3 sentences) so every pair has at least surface interaction.

## Phase 3: Rebuttal & Defence

After ALL debates complete, spawn ONE sub-agent per persona (parallel) with the **Rebuttal template**, feeding it everything said TO or ABOUT that persona. Output structure: 我承認嘅有效批評 / 我堅持唔變嘅立場 / 我提出嘅妥協方案 (300-500 字).

Emit one `rebuttal` event per persona (`"critic": "全體"`), paced **0.4-0.6s**.

## Phase 4: Position Revision

Spawn ONE sub-agent per persona (parallel) with the **Revision template**, feeding their original position + defence. Output: 修訂立場摘要 / 我改變咗嘅觀點 / 我仍然堅持嘅核心 / 畀決策者嘅建議 (200-400 字).

Emit each as `agent-proposal` (overwrites that persona's node content on the dashboard).

## Phase 5: Synthesis

Write the synthesis yourself (no sub-agent) using the 5-section structure in phase-templates.md — it must show the EVOLUTION of the debate, citing which round caused each shift:

✅ 辯論後共識 · 🔴 無法調和嘅分歧 · 🟡 有條件嘅妥協 · 📋 行動建議 · 🔍 意外發現

Emit `synthesis-complete`, then print the synthesis Markdown in chat, ending with:

```
🌐 Live dashboard: <SWARM_DASHBOARD_URL, default http://187.127.115.235:3010>
   (Click any node = full position paper + debate history; hover edge = exchange)
```

## Mid-jam: 加新 persona

Triggers: 「加多 X persona/agent」 / 「再加 X」 / 「now add X」 / 「臨時加 X 同 Y」

1. Spawn ONE sub-agent for the new persona with the same Phase 1 template → emit `persona-added`
2. Run a quick **2-round** debate vs the 1-2 existing personas whose positions conflict most → `debate-message` events, 0.5s spacing
3. Optionally re-emit `synthesis-complete` with an updated synthesis if the user asks for a refresh

## Mid-jam: 加 background context (rethink)

Triggers: 「加 context: X，重新諗一次」 / 「rethink with: X」 / 「補多個 info: X 俾佢哋」 / 「現實情況係 X，重新 jam」

1. Emit `context-update` with `{"context":"<short summary>","instruction":"rethink with constraint"}`
2. Spawn parallel sub-agents per persona with the **Rethink template** (flags any previous compromise now invalid)
3. Emit each revised `agent-proposal`, run a fresh 2-round debate focused on the new context's implications, re-emit `synthesis-complete` explicitly addressing the new context

## Failure modes

- **Dashboard unreachable**: emit-event.sh handles it (one warning, continue). Never fail the jam over visualization.
- **JSON escape issues**: escape multi-line content with `jq -Rs .` before building payloads.
- **Sub-agent returns invalid JSON in a debate**: treat it as plain text and wrap in a single `debate-message` instead of parsing rounds.
- **Too many personas (>8)**: reduce deep debate pairs to 3, increase quick-critique coverage, and warn the user that quality scales inversely with persona count.

## Example invocations

```
用校長/老師/科主任/學生/研發者 jam ORCA platform 整體架構
```
→ Topic: ORCA platform 整體架構; 5 explicit personas; skip persona proposal, confirm with one-liner.

```
swarm ORCA grading rubric design
```
→ Auto-suggest personas (e.g. 老師/學生/家長/教育局/AI開發者); ASK to confirm.

```
multi-persona analyze whether to add Cantonese voice grading
```
→ Auto-suggest personas; ASK to confirm.
