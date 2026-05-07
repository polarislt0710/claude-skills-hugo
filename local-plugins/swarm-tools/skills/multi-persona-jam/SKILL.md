---
name: multi-persona-jam
description: Orchestrate a multi-persona stakeholder design jam with real-time WebSocket visualization. 3 phases (Independent → Debate → Synthesis) with live updates streamed to dashboard at http://187.127.115.235:3010 (open second browser tab to see live graph). Activate when user says "用 N 個 persona/角度 jam/分析 X" / "stakeholder jam" / "multi-persona analyze X" / "swarm <topic>". Personas can be auto-suggested or explicitly listed.
---

# Multi-Persona Stakeholder Jam

Run a 3-phase swarm:
1. **Independent** — each persona thinks alone (parallel sub-agents)
2. **Debate** — personas critique each other (round-robin pairs)
3. **Synthesis** — identify consensus, contested points, action items

All events stream to `http://187.127.115.235:3010` for live visualization.

---

## Phase 0: Setup

1. Identify **TOPIC** from user prompt
2. Identify **PERSONAS**:
   - **Explicit list** in prompt (e.g. "用校長/老師/科主任/學生/研發者") → use those exactly
   - **No list** / "default" → propose 5-7 sensible personas, **ASK user to confirm**
3. Confirm with user one-liner: `🌀 Jam topic: X | Personas: [...] | OK?`
4. Wait for "go" / "ok" / "yes" before starting

---

## Phase 1: Independent Thinking (parallel sub-agents)

**CRITICAL: spawn ALL sub-agents in ONE message** (parallel execution, not serial).

Use the `Agent` tool, `subagent_type: "general-purpose"`, with this prompt template per persona:

```
You are <PERSONA_NAME> for the design jam on topic: <TOPIC>.

Output a tight 5-bullet structured Markdown response:
- **身份 (Identity)**: 1-line who you are in this system
- **需求 (Needs)**: 3-5 things you want from the system, ranked
- **痛點 (Pain)**: 3-5 frustrations you face today
- **反對 (Concerns)**: 2-3 things you'd push back on / refuse
- **期望 (Expectations)**: 2-3 success criteria you'd evaluate the system on

Be specific to your role. Do not generalize. Use plain language a non-engineer would use.
Return ONLY the 5 bullets, no preamble.
```

After ALL sub-agents return, emit one event per persona:

```bash
curl -s -X POST http://187.127.115.235:3010/events/agent-proposal \
  -H "Content-Type: application/json" \
  --data-binary @- <<JSON
{"agent": "<persona>", "content": <json-escaped content>}
JSON
```

**Before Phase 1 starts**, also emit a swarm-start event:

```bash
curl -s -X POST http://187.127.115.235:3010/events/swarm-start \
  -H "Content-Type: application/json" \
  -d '{"topic":"<TOPIC>","personas":["P1","P2","P3","P4","P5"]}'
```

---

## Phase 2: Debate (round-robin pairs)

For each unique persona pair (P_i, P_j) where i < j, generate **2 critiques**:
- `P_i → P_j`: 1 specific concern P_i has about P_j's needs/expectations
- `P_j → P_i`: 1 specific concern P_j has about P_i's needs/expectations

Total = N×(N-1) messages. For 5 personas = 20 messages.

Generate **inline in main thread** (no sub-agents — these are short critiques).

Each critique is 1-2 sentences. Format: `[Specific concern based on what P_j said in Phase 1, citing the conflict]`.

Emit each message:

```bash
curl -s -X POST http://187.127.115.235:3010/events/debate-message \
  -H "Content-Type: application/json" \
  -d '{"from":"P_i","to":"P_j","content":"<critique>"}'
```

Pace events: **insert a 200-500ms delay** (`sleep 0.3`) between curl calls so the dashboard animation is watchable.

---

## Phase 3: Synthesis

Output structured Markdown identifying:

- **✅ 共識 (Common ground)** — needs/expectations all (or most) personas agree on
- **⚠️ 爭議 (Contested)** — points where personas conflict, with which-vs-which
- **📋 Action Items** — concrete design decisions / TODOs to resolve

Emit:

```bash
curl -s -X POST http://187.127.115.235:3010/events/synthesis-complete \
  -H "Content-Type: application/json" \
  --data-binary @- <<JSON
{"content": <json-escaped synthesis markdown>}
JSON
```

---

## Final output to user

Print the synthesis Markdown in chat. End with:

```
🌐 Live dashboard: http://187.127.115.235:3010
   (Click any node = see persona detail; hover edge = see critique)
```

---

## Failure modes

- **Backend unreachable** (curl returns connection refused): print 1-line warning, continue without events. Don't fail the whole jam.
- **JSON escape issues**: use `jq -Rs .` to escape multi-line content into JSON string before curl.

---

## Example invocations

```
用校長/老師/科主任/學生/研發者 jam ORCA platform 整體架構
```
→ Topic: ORCA platform 整體架構; Personas: 5 explicit ones; skip Phase 0 confirmation, just confirm with one-liner.

```
swarm ORCA grading rubric design
```
→ Topic: ORCA grading rubric design; Personas: auto-suggest (e.g. 老師/學生/家長/教育局/AI開發者); ASK to confirm.

```
multi-persona analyze whether to add Cantonese voice grading
```
→ Topic: Cantonese voice grading feature; auto-suggest personas; ASK to confirm.
