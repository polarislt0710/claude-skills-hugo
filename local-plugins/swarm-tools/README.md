# swarm-tools

Multi-agent stakeholder jam with real-time WebSocket visualization.

## Skill: multi-persona-jam

Spawn N parallel sub-agents (each = a stakeholder persona), debate, converge.

Live graph dashboard at `http://187.127.115.235:3010` — open in second tab.

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
