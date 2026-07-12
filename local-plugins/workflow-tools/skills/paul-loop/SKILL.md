---
name: paul-loop
description: Plan-Apply-Unify Loop (PAUL) methodology to prevent context rot in long coding sessions. Use this skill for any multi-step coding task, feature implementation, or project work that spans multiple interactions. Triggers when user starts a new feature, asks to "plan this out", says "use PAUL", has a complex multi-file change, or when Claude detects the conversation is getting long. Prevents Claude from losing track of the overall goal while working on implementation details.
---

# PAUL: Plan-Apply-Unify Loop

Inspired by: https://github.com/ChristopherKahler/paul

## The Problem This Solves
In long coding sessions, Claude can "forget" the big picture while focused on implementation details. Context rot happens when:
- The conversation gets too long
- Multiple sub-tasks create confusion about the main goal
- Partial implementations pile up without cohesion

## The PAUL Loop

### Phase 1: PLAN 📋
Before writing any code:
1. Restate the goal in your own words
2. Break into concrete subtasks (numbered list)
3. Identify dependencies between subtasks
4. Estimate complexity (Simple/Medium/Complex)
5. Flag potential risks or unknowns
6. Get user confirmation before proceeding

**Output template:**
```
PLAN:
Goal: [one sentence]
Subtasks:
  1. [task] (Simple) - No dependencies
  2. [task] (Medium) - Depends on 1
  3. [task] (Complex) - Depends on 1, 2
Risks: [any unknowns]
Proceeding? ✓
```

### Phase 2: APPLY 🔨
Execute one subtask at a time:
1. State which subtask you're working on
2. Complete it fully before moving to next
3. After each subtask: mini-summary of what was done
4. Keep original plan visible in your working memory

**During apply, always track:**
- ✅ Completed subtasks
- 🔄 Current subtask
- ⏳ Remaining subtasks

### Phase 3: UNIFY 🔗
After all subtasks complete:
1. Review all changes holistically
2. Check for inconsistencies between parts
3. Ensure the original goal is fully met
4. Create a summary of everything changed
5. Identify any follow-up tasks

**Output template:**
```
UNIFY SUMMARY:
Original goal: [restate]
Changes made: [list of files/functions]
Goal achieved: ✅/⚠️/❌
Follow-ups: [any remaining tasks]
```

## Anti-Context-Rot Techniques
- **Checkpoint every 5 subtasks**: Brief "where are we" summary
- **Goal anchor**: Keep goal statement at top of long responses
- **Scope guard**: If new requirements emerge, note them but don't implement without re-planning

## Usage
- Start with: "Let's use PAUL for this"
- Or: "Plan this out before we start"
- Auto-activates for tasks with 3+ subtasks
- Upstream: **seed** (same plugin) hands off a complete PLANNING.md so PAUL starts with full context
