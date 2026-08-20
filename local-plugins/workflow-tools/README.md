# workflow-tools

Dev workflow & meta toolkit — 10 skills. 8 migrated from the Claude Desktop Skills store into git-managed plugin form (2026-07); `advise-project-approach` + `neuroarxiv` ported from `~/.codex/skills/` to Claude Code plugin form (2026-08-20).

| Skill | Purpose |
|---|---|
| `paul-loop` | Plan → Apply → Unify methodology against context rot |
| `seed` | Project incubator: raw idea → structured PLANNING.md (pairs with paul-loop) |
| `brainstormers` | Structured ideation (mind mapping, SCAMPER, Six Hats, starbursting…) |
| `everything-code` | CLAUDE.md configuration architecture for agent performance |
| `cli-anything` | Make any CLI tool agent-native (discovery, mapping, safe execution) |
| `research-last30days` | Recency-biased research methodology + report template |
| `awesome-code-skills` | Curated directory of the Claude Code skill ecosystem |
| `gstack` | Opinionated stack recommendations + scaffolding checklists |
| `advise-project-approach` | Research-backed project strategy: stack/architecture choice, real comparables, pricing & operating-cost reality, prioritized improvement plan (pre-build, mid-build, or post-build review) |
| `neuroarxiv` | Grounds architecture decisions in real arXiv prior art — real HTTP fetch, one isolated parallel Agent read per paper, then converges on ONE recommended path with citations and known pitfalls |

`brainstormers` is also injected into swarm-server Research/Strategy/Synthesis agents (see `services/swarm-server/server.js` SKILL_REGISTRY).
