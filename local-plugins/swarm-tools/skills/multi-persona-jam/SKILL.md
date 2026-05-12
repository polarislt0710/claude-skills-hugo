---
name: multi-persona-jam
description: Orchestrate a multi-persona stakeholder design jam with real-time WebSocket visualization. 5 phases (Position → Cross-Exam → Rebuttal → Revision → Synthesis) with live updates streamed to dashboard at http://187.127.115.235:3010 (open second browser tab to see live graph). Activate when user says "用 N 個 persona/角度 jam/分析 X" / "stakeholder jam" / "multi-persona analyze X" / "swarm <topic>". Personas can be auto-suggested or explicitly listed.
---

# Multi-Persona Stakeholder Jam

Run a 5-phase swarm with genuine multi-round debate:
1. **Position** — each persona writes a substantive position paper (parallel sub-agents)
2. **Cross-Examination** — contentious pairs do 2-3 rounds of real back-and-forth (sub-agents)
3. **Rebuttal** — each persona reviews all attacks and writes a defence (parallel sub-agents)
4. **Revision** — each persona revises their position based on what they learned (parallel sub-agents)
5. **Synthesis** — structured convergence citing debate outcomes

All events stream to `http://187.127.115.235:3010` for live visualization.

---

## Phase 0: Setup

1. Identify **TOPIC** from user prompt
2. Identify **PERSONAS**:
   - **Explicit list** in prompt (e.g. "用校長/老師/科主任/學生/研發者") → use those exactly
   - **No list** / "default" → propose 5-7 sensible personas, **ASK user to confirm**
3. Confirm with user one-liner: `🌀 Jam topic: X | Personas: [...] | OK?`
4. Wait for "go" / "ok" / "yes" before starting

**Before Phase 1 starts**, emit a swarm-start event:

```bash
curl -s -X POST http://187.127.115.235:3010/events/swarm-start \
  -H "Content-Type: application/json" \
  -d '{"topic":"<TOPIC>","personas":["P1","P2","P3","P4","P5"]}'
```

---

## Phase 1: Position Paper (parallel sub-agents)

**CRITICAL: spawn ALL sub-agents in ONE message** (parallel execution, not serial).

Use the `Agent` tool, `subagent_type: "general-purpose"`, with this prompt template per persona:

```
You are <PERSONA_NAME> participating in a structured debate about: <TOPIC>.

Write a POSITION PAPER — a substantive, opinionated document that other personas will read and challenge. This is NOT a survey response; it's your opening argument.

**LANGUAGE RULES**:
- Non-technical personas (校長, 老師, 學生, 家長, etc.): use everyday Cantonese. NO jargon. NO English mixed in unless standard (e.g. "AI"). Talk like a real person.
- Technical personas (研發者, 工程師, CTO): can use technical terms but always explain in parens on first use.
- AVOID empty buzzwords: "scale", "ROI", "synergy", "leverage". Replace with concrete phrases.
- Specific > abstract: "我哋 5 個老師，3 個凌晨先收工" >>> "teacher burnout"

**STRUCTURE — use ### headers exactly:**

### 我嘅立場
3-5 sentences. Your core thesis on this topic. What you believe should happen and WHY. Be opinionated — take a clear side. State your reasoning, not just your preference.

### 我最關心嘅 3 件事
- 3 bullets, each 2-3 sentences with a concrete example, number, or scenario
- Explain the CONSEQUENCE if this isn't addressed (what breaks, who suffers)
- Bold the **key phrase** in each

### 我嘅底線（唔可以讓步）
- 2-3 hard "no"s — things you would rather walk away than accept
- For each: explain WHY this is non-negotiable (the deeper reason, not just preference)
- These should feel like genuine constraints, not posturing

### 我可以妥協嘅範圍
- 2-3 areas where you're flexible, with CONDITIONS
- Format: "我可以接受 X，**但前提係** Y" — show you're reasonable but not a pushover

### 我對其他角色嘅預判
- For 2-3 other personas in this jam, predict what they'll say and pre-emptively explain why you disagree or why their concern is less important than yours
- This is strategic positioning — show you've thought about the opposition

Total: aim for **500-800 字** of substantive content.
Be specific to your role. Stay in character throughout.
```

After ALL sub-agents return, emit one event per persona:

```bash
curl -s -X POST http://187.127.115.235:3010/events/agent-proposal \
  -H "Content-Type: application/json" \
  --data-binary @- <<JSON
{"agent": "<persona>", "content": <json-escaped content>}
JSON
```

---

## Phase 2: Cross-Examination (multi-round debate via sub-agents)

This is the core innovation. Instead of shallow one-line critiques, run **genuine multi-round debates** between the most contentious persona pairs.

### Step 1: Identify contentious pairs

From Phase 1 outputs, identify **3-4 pairs** where positions directly conflict. Look for:
- Contradictory bottom lines (A's non-negotiable violates B's core need)
- Resource competition (both want the same thing but differently)
- Values clash (efficiency vs equity, speed vs safety, etc.)

Rank by how irreconcilable the conflict seems. Pick the top 3-4 pairs.

### Step 2: Run debates (sub-agents, parallel where independent)

For each contentious pair (A, B), spawn ONE sub-agent that runs the full exchange:

```
You are simulating a STRUCTURED DEBATE between two personas about: <TOPIC>.

**Persona A — <A_NAME> (<A_ROLE>):**
<A's full Phase 1 position paper>

**Persona B — <B_NAME> (<B_ROLE>):**
<B's full Phase 1 position paper>

**THE CORE CONFLICT:**
<1-2 sentence description of why these two positions clash>

Run a 3-round cross-examination. Each speaker gets 150-250 字 per turn. Stay in character for each persona — use their language style and concerns.

**LANGUAGE**: Match each persona's register. Non-technical personas use everyday Cantonese. Technical personas can use terms but explain them. Both should feel like real people arguing, not policy documents talking at each other.

**RULES FOR GOOD DEBATE:**
- ALWAYS quote or reference what the other person just said ("你話 X，但係...")
- Challenge the REASONING, not just the conclusion
- Bring NEW evidence or examples each round — don't just repeat
- Acknowledge valid points before pushing back ("呢點我同意，不過...")
- Escalate specificity each round — Round 1 is broad, Round 3 is about concrete details
- Show genuine tension — it's OK to get heated, interrupt logic, call out contradictions

Output format — return EXACTLY this JSON (no markdown wrapper):

{
  "rounds": [
    {
      "round": 1,
      "label": "開場質詢",
      "exchanges": [
        {"from": "<A_NAME>", "to": "<B_NAME>", "content": "..."},
        {"from": "<B_NAME>", "to": "<A_NAME>", "content": "..."}
      ]
    },
    {
      "round": 2,
      "label": "深入追問",
      "exchanges": [
        {"from": "<A_NAME>", "to": "<B_NAME>", "content": "..."},
        {"from": "<B_NAME>", "to": "<A_NAME>", "content": "..."}
      ]
    },
    {
      "round": 3,
      "label": "最終交鋒",
      "exchanges": [
        {"from": "<A_NAME>", "to": "<B_NAME>", "content": "..."},
        {"from": "<B_NAME>", "to": "<A_NAME>", "content": "..."}
      ]
    }
  ],
  "unresolved": "1 sentence: what remains unresolved after 3 rounds",
  "surprise": "1 sentence: something unexpected that emerged from this debate"
}
```

### Step 3: Emit debate events

Parse the JSON from each sub-agent. For each exchange in each round, POST a `debate-message` event:

```bash
curl -s -X POST http://187.127.115.235:3010/events/debate-message \
  -H "Content-Type: application/json" \
  --data-binary @- <<JSON
{"from":"<from>","to":"<to>","content":"【第 <round> 回合 — <label>】\n\n<content>"}
JSON
```

Pace events: **0.5-0.8s sleep between POSTs** so the dashboard animation is watchable.

### Step 4: Remaining pairs (quick critiques)

For persona pairs NOT selected for deep debate, generate a single critique each direction (inline, 2-3 sentences each). This ensures every pair has at least surface interaction.

---

## Phase 3: Rebuttal & Defence (parallel sub-agents)

After ALL Phase 2 debates complete, each persona reviews everything directed at them.

Spawn ONE Agent sub-agent per persona (parallel — all N at once):

```
You are <PERSONA X> (<ROLE>).

You just went through a structured debate about: <TOPIC>.

Here is everything said TO you or ABOUT you during the cross-examination:

<For each debate X participated in, include the full exchange>
<For quick critiques directed at X, include those too>

Now write your DEFENCE AND REFLECTION. Structure:

### 我承認嘅有效批評
- 2-3 points from other personas that you now accept were valid
- For each: explain what specifically changed your thinking

### 我堅持唔變嘅立場
- 2-3 points you STILL disagree with despite the criticism
- For each: explain WHY the criticism didn't convince you (new reasoning, not just repeating yourself)

### 我提出嘅妥協方案
- 1-2 concrete compromises that address critics' concerns WITHOUT abandoning your core position
- Be specific: "我可以接受 X 方案，前提係加入 Y 保障，同時 Z 嘅時間表延長到..."

Stay in character. 300-500 字 total. Use your natural language register.
```

Parse responses and POST rebuttal events:

```bash
curl -s -X POST http://187.127.115.235:3010/events/rebuttal \
  -H "Content-Type: application/json" \
  --data-binary @- <<JSON
{"agent": "<X>", "critic": "全體", "content": <jq-Rs-escaped response>}
JSON
```

Pace: **0.4-0.6s sleep between POSTs**.

---

## Phase 4: Position Revision (parallel sub-agents)

Each persona writes their FINAL revised position, incorporating what they learned.

Spawn ONE Agent sub-agent per persona (parallel):

```
You are <PERSONA X>. You've been through a full debate cycle about: <TOPIC>.

Your ORIGINAL position (Phase 1):
<original position paper>

Your DEFENCE after debate (Phase 3):
<defence/rebuttal content>

Now write your REVISED POSITION — your final word. Structure:

### 修訂立場摘要
2-3 sentences. What is your position NOW vs before? What shifted?

### 我改變咗嘅觀點
- Bullets showing specific changes, with "之前我覺得 X → 而家我覺得 Y，因為 Z"

### 我仍然堅持嘅核心
- Bullets showing what survived the debate and WHY it's even stronger now

### 畀決策者嘅建議
- 2-3 actionable recommendations from your perspective, written for someone who has to make a decision tomorrow

Stay in character. 200-400 字 total.
```

POST each revised position as an updated proposal:

```bash
curl -s -X POST http://187.127.115.235:3010/events/agent-proposal \
  -H "Content-Type: application/json" \
  --data-binary @- <<JSON
{"agent": "<persona>", "content": <json-escaped revised content>}
JSON
```

---

## Phase 5: Synthesis

Generate structured Markdown that shows the EVOLUTION of the debate, not just a static summary.

Structure:

```markdown
## ✅ 辯論後共識（Debate-Earned Consensus）
- Points where personas STARTED disagreeing but CONVERGED through debate
- For each: which debate round caused the shift, and what compromise unlocked it

## 🔴 無法調和嘅分歧（Irreconcilable Tensions）
- Points where 3 rounds of debate FAILED to resolve the conflict
- For each: name the two sides, their final positions, and WHY neither will budge
- These are the REAL tradeoffs a decision-maker must face

## 🟡 有條件嘅妥協（Conditional Agreements）
- Points where personas agreed IF certain conditions are met
- For each: the condition, who proposed it, who accepted it

## 📋 行動建議（Decision Brief）
- 3-5 concrete next steps, ranked by urgency
- For each: note which personas support it and which have reservations
- Flag any action that REQUIRES resolving an irreconcilable tension first

## 🔍 意外發現（Debate Surprises）
- 1-3 insights that ONLY emerged from the cross-examination
- Things no single persona would have identified alone
```

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
   (Click any node = see full position paper + debate history; hover edge = see exchange)
```

---

## Mid-jam: 加新 persona

**Trigger phrases**:
- 「加多 X persona / agent」 / 「再加 X」
- 「now add X」
- 「臨時加 X 同 Y」

**Steps** (when triggered AFTER an existing swarm is running or complete):

1. Spawn ONE Agent sub-agent for the new persona using SAME Phase 1 prompt template
2. POST result to `/events/persona-added`:
   ```bash
   curl -s -X POST http://187.127.115.235:3010/events/persona-added \
     -H "Content-Type: application/json" \
     --data-binary @- <<JSON
   {"agent": "<new persona>", "content": <jq -Rs . escaped content>}
   JSON
   ```
3. Run a quick 2-round debate between the new persona and the 1-2 existing personas whose positions conflict most
4. POST those `debate-message` events with 0.5s spacing
5. Optionally re-emit `synthesis-complete` with updated synthesis if user asks for refresh

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
2. For each existing persona, spawn an Agent sub-agent (parallel) with rethink prompt:
   ```
   You are <PERSONA>. Your current position (post-debate) was:
   <revised position content>

   New context just emerged: <context>

   Output a REVISED perspective using the same ### structure.
   At the top, add a 1-line summary of WHAT CHANGED in your view due to the new context.
   Flag any previous compromise that is now INVALID because of this new information.
   ```
3. POST each revised proposal as `agent-proposal` (overwrites previous content on dashboard)
4. Run a fresh 2-round debate focusing specifically on the new context's implications
5. Re-emit `synthesis-complete` with updated synthesis explicitly addressing the new context

---

## Failure modes

- **Backend unreachable** (curl returns connection refused): print 1-line warning, continue without events. Don't fail the whole jam.
- **JSON escape issues**: use `jq -Rs .` to escape multi-line content into JSON string before curl.
- **Sub-agent returns invalid JSON in debate**: treat as plain text, wrap in a single debate-message event instead of parsing rounds.
- **Too many personas (>8)**: reduce deep debate pairs to 3, increase quick critique coverage. Warn user that quality scales inversely with persona count.

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
