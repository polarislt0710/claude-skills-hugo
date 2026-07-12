# Multi-Persona Jam — Sub-Agent Prompt Templates

Copy-paste templates for each phase. Placeholders in `<ANGLE_BRACKETS>`.

## Phase 1 — Position Paper template

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

## Phase 2 — Debate template (one sub-agent per contentious pair)

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

## Phase 3 — Rebuttal & Defence template (one sub-agent per persona)

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

## Phase 4 — Position Revision template (one sub-agent per persona)

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

## Mid-jam Rethink template (one sub-agent per persona, after context-update)

```
You are <PERSONA>. Your current position (post-debate) was:
<revised position content>

New context just emerged: <context>

Output a REVISED perspective using the same ### structure.
At the top, add a 1-line summary of WHAT CHANGED in your view due to the new context.
Flag any previous compromise that is now INVALID because of this new information.
```

## Phase 5 — Synthesis structure (written by the orchestrator, not a sub-agent)

Show the EVOLUTION of the debate, not just a static summary:

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
