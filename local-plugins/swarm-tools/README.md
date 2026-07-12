# swarm-tools

Multi-agent stakeholder jam with real-time WebSocket visualization + swarm execution rules.

## Skill: multi-persona-jam

Spawn N parallel sub-agents (each = a stakeholder persona), run a 5-phase debate (Position → Cross-Exam → Rebuttal → Revision → Synthesis), converge.

- Live graph dashboard: `SWARM_DASHBOARD_URL` (default `http://187.127.115.235:3010`) — open in a second tab
- Events are emitted via the bundled `scripts/emit-event.sh`; prompt templates live in `references/phase-templates.md`, payload specs in `references/dashboard-events.md`

## Skill: execution-discipline

鐵則 — swarm agent 執行紀律 (evidence-before-done, probe-first, escalate-when-blocked). Injected into EVERY swarm-server agent prompt via `SKILL_REGISTRY` in `services/swarm-server/server.js`.

## Backend service

The skill posts events to a separate Node.js backend (`services/swarm-server/`).
Backend serves both the WebSocket endpoint and the dashboard HTML.

Deploy to VPS:
```bash
ssh orca 'mkdir -p ~/services && cd ~/services && \
  git clone https://github.com/polarislt0710/claude-skills-hugo.git ../tmp-clone && \
  cp -r ../tmp-clone/services/swarm-server ./swarm-server && rm -rf ../tmp-clone && \
  cd swarm-server && npm install && pm2 start server.js --name swarm-server && pm2 save'
ssh orca 'sudo ufw allow 3010/tcp comment "Swarm dashboard"'
```
