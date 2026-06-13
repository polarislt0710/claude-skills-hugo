# Mission Skill Audit — Prompt Distillation

Date: 2026-05-18

## Decision

Do not make Mission agents dynamically call skills yet. Instead, distill the reusable thinking patterns from relevant skills into Mission phase prompts.

This keeps the pipeline deterministic:

- fewer moving parts inside non-interactive agents
- easier prompt review and debugging
- no accidental injection of huge automation/API skills
- stable behavior after CloudCLI / mission restarts

## Scan Summary

Scanned approximately 900+ `SKILL.md` files across:

- `~/.codex/skills/`
- `~/.codex/skills/.system/`
- `~/.claude/local-marketplace/local-plugins/`
- cached Hugo personal skills under `~/.claude/plugins/cache/`
- Claude local-agent-mode session skills

Most files are API automation skills. They are intentionally skipped for Mission prompts because they contain connector/tool usage instructions rather than general engineering judgement.

## Skills Distilled

| Skill | Source | Used In | Extracted Value |
|---|---|---|---|
| `paul-loop` | standalone Claude session skill | planner, coding | Plan / Apply / Unify discipline for long tasks |
| `everything-code` | standalone Claude session skill | coding | research-first coding, small diffs, security constraints |
| `tdd` | mattpocock-skills | planner, coding, refill, fix | behavior-first tests, vertical slices, no horizontal test dumps |
| `diagnose` | mattpocock-skills | fix, review | reproduce first, falsifiable hypotheses, regression tests |
| `improve-codebase-architecture` | mattpocock-skills | planner, coding, refill | deep modules, deletion test, interface as test surface |
| `zoom-out` | mattpocock-skills | planner, coding | map modules/callers before editing unfamiliar areas |
| `reviewer` | super-personas | review | correctness/readability/maintainability/perf/security/test rubric |
| `security-auditor` | super-personas | review | adversarial review of authz, inputs, secrets, trust boundaries |
| `performance-engineer` | super-personas | review | measure-first performance sweep; N+1/hot path/resource checks |
| `refactor-engineer` | super-personas | refill | behavior-preserving small refactors with tests |
| `architect` | super-personas | planner, review | interface contracts, failure modes, coupling assessment |
| `debugger` | super-personas | fix | smallest reproducer, root cause, regression confirmation |
| `design/components` | design plugin | refill | buttons/forms/cards/icons/motion component checks |
| `design/layout` | design plugin | refill | grid, spacing, alignment, proximity, visual hierarchy checks |
| `design/color` | design plugin | refill | WCAG contrast, semantic color, surface hierarchy |
| `design/typography` | design plugin | refill | type scale, line height, measure, contrast |
| `session-continuity` | standalone Claude session skill | summary | current state, next actions, critical context |
| `consolidate-memory` | standalone Claude session skill | summary | separate durable takeaways from dated detail |
| `changelog-generator` | standalone Codex skill | summary | technical commits to user-facing release notes |

## Skills Skipped

| Category | Reason |
|---|---|
| API automation skills | Tool-specific execution plans, not useful as general Mission judgement |
| Image/video prompt skills | Not relevant to ORCA coding mission by default |
| Marketing/copywriting/SEO | Useful only for product/content missions, not default code pipeline |
| Browser/data/spreadsheet skills | Should be explicitly triggered by plan content, not always injected |

## New Phase Order

Previous:

```text
coding -> refill -> review
```

New:

```text
coding -> review -> refill
```

Reason:

- Review is the quality gate.
- If coding output is fundamentally wrong, skip refill and spend the next tokens on fix iteration.
- If review returns `PASS` or `WARN`, refill receives `findings.md` and can spend tokens on targeted polish.

Auto-orchestrator behavior:

```text
coding
review
if FAIL:
  next coding fix iteration
if PASS/WARN:
  refill
  finish sub-phase
```

## Prompt Changes Made

| Prompt | Added |
|---|---|
| `mission-planner-system.md` | vertical slice planning, risk flags, observable behavior/test signal |
| `mission-coding-system.md` | research-first, PAUL-lite, TDD discipline, architecture discipline |
| `mission-review-system.md` | pre-refill review framing, severity gate, security/performance/test evidence rubric |
| `mission-refill-system.md` | consume review findings first, behavior-preserving refactor, UI polish checks |
| `mission-fix-iteration.md` | reproduce/confirm issue, smallest fix, regression test |
| `mission-final-summary-system.md` | continuity, durable decisions, user-facing changelog framing |

## Future Option

If Mission Control later needs per-mission skill selection, add a UI field like:

```json
{
  "skillProfile": "default-code",
  "extraPromptAddons": ["design-ui", "security-heavy"]
}
```

For now, the distilled default profile is simpler and safer.
