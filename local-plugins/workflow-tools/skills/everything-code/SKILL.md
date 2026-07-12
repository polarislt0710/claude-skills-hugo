---
name: everything-code
description: CLAUDE.md configuration system for maximum agent performance. Covers identity, instincts, memory architecture, security hardening, and research-first development patterns for Claude Code and AI coding agents. Use when setting up a new project's CLAUDE.md, optimising Claude Code performance, configuring agent behaviours, or when the user asks about best practices for AI-assisted development workflows. Triggers for "set up CLAUDE.md", "optimise Claude Code", "agent harness", "configure Claude for my project".
---

# Everything Claude Code

Inspired by: https://github.com/affaan-m/everything-claude-code
"The agent harness performance optimisation system"

## What This Skill Does
Helps you build the perfect CLAUDE.md configuration that turns Claude Code into a high-performance coding agent with memory, skills, security constraints, and research-first behaviours.

## CLAUDE.md Architecture

### The Four Pillars
```
CLAUDE.md
├── IDENTITY      — Who Claude is in this project
├── INSTINCTS     — Default behaviours and heuristics
├── MEMORY        — What to remember across sessions
└── CONSTRAINTS   — What never to do
```

## Identity Section Template
```markdown
# Project Identity

## Role
You are a senior [tech stack] engineer working on [project name].
[project description in 2-3 sentences]

## Tech Stack
- Frontend: [e.g. Next.js 14, TypeScript, Tailwind]
- Backend: [e.g. FastAPI, PostgreSQL, Redis]
- Infrastructure: [e.g. Vercel, AWS, Docker]

## Code Style
- Language: TypeScript strict mode
- Formatting: Prettier (see .prettierrc)
- Linting: ESLint (see .eslintrc)
- Testing: Vitest + React Testing Library
```

## Instincts Section Template
```markdown
## Development Instincts

### Research First
Before implementing any feature:
1. Search existing codebase for similar patterns
2. Check if a library already solves this
3. Review related tests to understand expected behaviour
4. Only then write new code

### Small Changes
- Prefer the smallest diff that solves the problem
- One PR = one logical change
- Never refactor while adding features

### Test-Driven
- Write the test first when fixing bugs
- Ensure tests pass before marking task done
- Keep test coverage above 80%

### Error Handling
- Never swallow errors silently
- Log with context: what failed, where, why
- Use typed errors, not generic Error
```

## Memory Section Template
```markdown
## Project Memory

### Architecture Decisions
- [DATE] Chose Prisma over Drizzle: better type inference for complex relations
- [DATE] Using tRPC: full-stack type safety without REST overhead
- [DATE] Redis for sessions: faster than JWT validation at scale

### Known Gotchas
- Auth middleware must run before rate limiter (order matters in Next.js)
- Prisma client must be singleton in development (hot reload issue)
- Images must go through /api/images proxy (CORS restriction)

### Conventions
- Component files: PascalCase (UserCard.tsx)
- Utility files: camelCase (formatDate.ts)
- API routes: kebab-case (/api/user-profile)
- Database: snake_case (user_profiles table)
```

## Security Constraints Template
```markdown
## Security Constraints

### Never Do
- Never log request bodies containing passwords or tokens
- Never commit .env files or API keys
- Never use eval() or dynamic imports from user input
- Never skip authentication on /api routes
- Never directly interpolate user input into SQL

### Always Do
- Always validate and sanitise user input with Zod
- Always use parameterised queries
- Always check authorisation, not just authentication
- Always rate-limit auth endpoints
```

## Performance Optimisation Patterns

### Research-First Development
```markdown
Before writing code, Claude should:
1. grep/search codebase for similar patterns
2. Check package.json for relevant existing libs
3. Read related test files for context
4. Check git blame on nearby code for history
```

### Memory Architecture
```markdown
## Session Memory Protocol
At the start of each session:
- Read CLAUDE.md fully
- Check DECISIONS.md for recent choices
- Review current branch and recent commits

At the end of each session:
- Update DECISIONS.md with new choices made
- Update GOTCHAS.md with issues encountered
- Leave a TODO comment on any unfinished work
```

## Companion Files to Create

### DECISIONS.md
```markdown
# Architecture Decisions Log
| Date | Decision | Rationale | Alternatives Considered |
|------|----------|-----------|------------------------|
| 2026-04 | Prisma over Drizzle | Better TS inference | Drizzle (faster), TypeORM (heavier) |
```

### GOTCHAS.md
```markdown
# Known Gotchas and Traps
## [Module/Area]
- **Trap**: [describe the trap]
  **Solution**: [how to avoid it]
```

Pairs with **paul-loop** (same plugin) for structured task execution once the harness is configured.
