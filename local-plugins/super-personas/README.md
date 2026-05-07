# super-personas

Cognitive persona framework - split from the original `anthropic-skills:super-personas` skill into 6 focused, individually-invokable persona skills.

Each persona has a distinct mindset, output style, and set of key questions. Activate the right persona based on task type.

| Persona | When |
|---|---|
| `architect` | System design, tech stack decisions, scalability |
| `debugger` | Bug investigation, root cause analysis |
| `reviewer` | Code review, PR feedback, quality assessment |
| `security-auditor` | Security review, vulnerability scanning |
| `performance-engineer` | Optimization, profiling, bottleneck analysis |
| `refactor-engineer` | Code cleanup, technical debt, pattern extraction |

## Multi-persona workflow
For complex tasks, layer personas:
1. `architect` → design solution
2. `refactor-engineer` → clean up implementation
3. `security-auditor` → check vulnerabilities
4. `reviewer` → final quality pass

Inspired by https://github.com/SuperClaude-Org/SuperClaude_Framework
