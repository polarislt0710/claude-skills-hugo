---
name: awesome-code-skills
description: Curated directory of the best Claude Code skills, hooks, slash-commands, agent orchestrators, and plugins. Use as a discovery tool when looking for skills to add, when wondering if a skill exists for a specific task, or when exploring what the Claude Code ecosystem offers. Triggers when user asks "is there a skill for X", "what skills exist for Y", "find me a Claude Code tool for Z", or "what are the best Claude Code extensions". Acts as a knowledge base and recommendation engine for the Claude Code ecosystem.
---

# Awesome Claude Code — Ecosystem Directory

Inspired by: https://github.com/hesreallyhim/awesome-claude-code
"A curated list of awesome skills, hooks, slash-commands, agent orchestrators, applications, and plugins for Claude Code"

## How to Use This Skill
When a user asks "is there a skill for X?", check in this order:
1. **Already installed?** — the `hugo-personal` plugins (workflow-tools, media-tools, data-tools, design, marketing, ai-prompts, super-personas, swarm-tools) and Claude Code built-ins listed below
2. **This directory** — external ecosystem tools worth installing
3. **Nothing fits** → suggest creating a new skill with the skill-creator

## Covered by built-ins (don't install a skill for these)
| Need | Built-in |
|------|----------|
| Code review | `/code-review` slash command |
| Security review | `/security-review` slash command |
| Persistent memory | Native Claude Code memory system |
| Deep research | `deep-research` skill (Desktop/Cowork) |
| Task tracking | Native task tools / `productivity` plugin |

## Installed locally (hugo-personal marketplace)
| Skill | Plugin |
|-------|--------|
| paul-loop, seed, brainstormers, everything-code, cli-anything, research-last30days, gstack | workflow-tools |
| cantonese-ai (TTS), remotion (programmatic video) | media-tools |
| duckdb-data (SQL analytics) | data-tools |
| typography, color, layout, components, web-motion-design, taste | design |
| copywriting, content-templates, growth-strategies, conversion, seo | marketing |
| image, single-shot-video, multi-shot-video prompt builders | ai-prompts |
| architect, debugger, reviewer, security-auditor, performance-engineer, refactor-engineer | super-personas |
| multi-persona-jam, execution-discipline | swarm-tools |

## External ecosystem (worth knowing)

### Memory & Context
| Tool | Description | Source |
|------|-------------|--------|
| claude-mem | Persistent memory across sessions | thedotmack/claude-mem |
| continuous-claude | Session handoff and continuity | parcadei/Continuous-Claude-v3 |

### Development Workflow
| Tool | Description | Source |
|------|-------------|--------|
| superclaude | Cognitive personas framework | SuperClaude-Org |
| openspace | Self-evolving agents | HKUDS/OpenSpace |
| vibe-kanban | AI-native task management | BloopAI/vibe-kanban |
| everything-claude-code | CLAUDE.md harness reference | affaan-m/everything-claude-code |

### Design & Frontend
| Tool | Description | Source |
|------|-------------|--------|
| impeccable | 20 design commands | pbakaus/impeccable |
| taste-skill | Reference-based design | Leonxlnx/taste-skill |
| emilkowalski/skill | Animation and motion | emilkowalski/skill |

### Video & Media
| Tool | Description | Source |
|------|-------------|--------|
| remotion skills | Production Remotion patterns | remotion-dev/skills |
| video-db | Video indexing and search | video-db/skills |

### Content & Writing
| Tool | Description | Source |
|------|-------------|--------|
| marketingskills | Copywriting and growth | coreyhaines31/marketingskills |
| superpowers | Six thinking modes | obra/superpowers |
| humanizer | Remove AI writing patterns | (Desktop Skills store) |

## Hooks and Automations

### Pre-commit Hook Pattern
```bash
# Run security review before every commit
claude -p "Quick security scan: $(git diff --staged)"
```

### Session Start Hook
```bash
# Auto-load context at session start
echo "Reading CLAUDE.md and recent commits..."
cat CLAUDE.md
git log --oneline -10
```

## Ecosystem Discovery
When a user needs something not in this list:
1. Check https://github.com/hesreallyhim/awesome-claude-code for latest additions
2. Browse the official plugin marketplace: `claude plugin marketplace` (anthropics/claude-plugins-official)
3. Create a custom skill with **skill-creator**

External sources in this directory can drift — verify a repo still exists and is maintained before recommending installation.
