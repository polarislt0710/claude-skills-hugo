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

Output structured Markdown using PROPER HEADERS (### will render as styled section blocks in the dashboard). Format EXACTLY like this:

### 身份 Identity
1-line who you are in this system.

### 需求 Needs
- 3-5 bulleted things you want from the system, ranked
- Use **bold** for key terms

### 痛點 Pain points
- 3-5 frustrations you face today
- Be specific and concrete

### 反對 Concerns
- 2-3 things you would push back on / refuse
- Why this matters to you

### 期望 Expectations
- 2-3 success criteria you would evaluate the system on
- Quantify when possible

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

## Phase 2.5: Rebuttals (對應回應)

After all Phase 2 critiques are POSTed, run a structured rebuttal round.

For each persona X, **gather all critiques where X was the recipient** (you sent N×(N-1) messages, so X has up to N-1 critiques against them).

Spawn ONE Agent sub-agent per persona (parallel — all N at once) with this prompt:

```
You are <PERSONA X>.

The following critiques were raised against your perspective in Phase 2:

[from 老師]: "<critique 1>"
[from 校長]: "<critique 2>"
[from 學生]: "<critique 3>"
[from 科主任]: "<critique 4>"

For EACH critique, write a 2-3 sentence response addressing the SPECIFIC concern, in your voice as <PERSONA X>. Stay in character. Acknowledge valid points, push back where appropriate, propose concrete compromises.

Output ONLY a JSON array (no markdown wrapper):
[
  {"critic": "老師", "content": "..."},
  {"critic": "校長", "content": "..."},
  {"critic": "學生", "content": "..."},
  {"critic": "科主任", "content": "..."}
]
```

Parse the JSON. For each response, POST a rebuttal event:

```bash
curl -s -X POST http://187.127.115.235:3010/events/rebuttal \
  -H "Content-Type: application/json" \
  --data-binary @- <<JSON
{"agent": "<X>", "critic": "<critic name>", "content": <jq-Rs-escaped response>}
JSON
```

Pace: **0.4-0.6s sleep between POSTs** so dashboard animation is watchable.

The dashboard will:
- Store rebuttals per persona
- When user clicks a persona card, render `對應回應` section showing each critique-response pair as a framed exchange-card with critic's avatar + name + their critique + this persona's response

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

## Mid-jam: 加新 persona

**Trigger phrases**:
- 「加多 X persona / agent」 / 「再加 X」
- 「now add X」
- 「臨時加 X 同 Y」

**Steps** (when triggered AFTER an existing swarm is running or complete):

1. Spawn ONE Agent sub-agent for the new persona using SAME Phase 1 prompt template (### 身份/需求/痛點/反對/期望)
2. POST result to `/events/persona-added`:
   ```bash
   curl -s -X POST http://187.127.115.235:3010/events/persona-added \
     -H "Content-Type: application/json" \
     --data-binary @- <<JSON
   {"agent": "<new persona>", "content": <jq -Rs . escaped content>}
   JSON
   ```
3. Generate 2 critique pairs between new persona and 2-3 most-relevant existing personas (e.g. critique pair with the persona whose needs CONFLICT most)
4. POST those `debate-message` events with 0.5s spacing
5. Optionally re-emit `synthesis-complete` with updated synthesis if user asks for refresh

The dashboard will:
- Show floating notification「✨ 新 persona 加入: <name>」for 3.5s
- Add new persona card to graph
- Auto-add dashed baseline edges between new persona and all existing nodes

---

## Mid-jam: 加 background context (rethink)

**Trigger phrases**:
- 「加 context: X，重新諗一次」 / 「rethink with: X」
- 「補多個 info: X 俾佢哋」
- 「現實情況係 X，重新 jam」

**Steps**:

1. POST context update to `/events/context-update`:
   ```bash
   curl -s -X POST http://187.127.115.235:3010/events/context-update \
     -H "Content-Type: application/json" \
     -d '{"context":"<short summary>","instruction":"rethink with constraint"}'
   ```
2. For each existing persona, spawn an Agent sub-agent (parallel) with this rethink prompt:
   ```
   You are <PERSONA>. Your previous perspective was:
   <previous content>

   New context just emerged: <context>

   Output a REVISED perspective using the same ### 身份/需求/痛點/反對/期望 structure.
   At the top, add a 1-line summary of WHAT CHANGED in your view due to the new context.
   ```
3. POST each revised proposal as `agent-proposal` (overwrites previous content on dashboard)
4. Run a fresh debate round (~10 messages) addressing the new context
5. Re-emit `synthesis-complete` with updated synthesis explicitly addressing the new context

The dashboard will:
- Show gold context banner across top of graph showing the latest context
- Increment context count badge `×1, ×2, ...`
- Show floating notification「💡 加咗 context — personas 重新諗中」
- Update persona cards' content silently (click to see revised perspective)

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
