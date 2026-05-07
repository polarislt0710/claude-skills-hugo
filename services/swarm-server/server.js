const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
const PORT = process.env.PORT || 3010;

app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

let currentSwarm = freshSwarm();

function freshSwarm() {
  return {
    id: null,
    topic: null,
    personas: [],
    proposals: {},
    debates: [],
    synthesis: null,
    status: 'idle',
    contextHistory: [],
    startedAt: null,
  };
}

app.post('/events/swarm-start', (req, res) => {
  const { topic, personas } = req.body || {};
  if (!topic || !Array.isArray(personas)) return res.status(400).json({ error: 'topic + personas required' });
  currentSwarm = freshSwarm();
  currentSwarm.id = Date.now();
  currentSwarm.topic = topic;
  currentSwarm.personas = personas;
  currentSwarm.status = 'phase-1';
  currentSwarm.startedAt = new Date().toISOString();
  io.emit('swarm-start', { id: currentSwarm.id, topic, personas });
  console.log(`[swarm-start] ${topic} | ${personas.length} personas`);
  res.json({ ok: true, id: currentSwarm.id });
});

app.post('/events/agent-proposal', (req, res) => {
  const { agent, content } = req.body || {};
  if (!agent || !content) return res.status(400).json({ error: 'agent + content required' });
  currentSwarm.proposals[agent] = content;
  if (Object.keys(currentSwarm.proposals).length === currentSwarm.personas.length) {
    currentSwarm.status = 'phase-2';
  }
  io.emit('agent-proposal', { agent, content, status: currentSwarm.status });
  console.log(`[proposal] ${agent}`);
  res.json({ ok: true });
});

app.post('/events/debate-message', (req, res) => {
  const { from, to, content } = req.body || {};
  if (!from || !to || !content) return res.status(400).json({ error: 'from + to + content required' });
  const msg = { from, to, content, ts: Date.now() };
  currentSwarm.debates.push(msg);
  io.emit('debate-message', msg);
  console.log(`[debate] ${from} → ${to}`);
  res.json({ ok: true });
});

app.post('/events/synthesis-complete', (req, res) => {
  const { content } = req.body || {};
  if (!content) return res.status(400).json({ error: 'content required' });
  currentSwarm.synthesis = content;
  currentSwarm.status = 'complete';
  io.emit('synthesis-complete', { content });
  console.log(`[synthesis] complete`);
  res.json({ ok: true });
});

// === NEW: add a persona mid-jam ===
app.post('/events/persona-added', (req, res) => {
  const { agent, content } = req.body || {};
  if (!agent) return res.status(400).json({ error: 'agent required' });
  if (!currentSwarm.personas.includes(agent)) {
    currentSwarm.personas.push(agent);
  }
  if (content) {
    currentSwarm.proposals[agent] = content;
  }
  io.emit('persona-added', { agent, content });
  console.log(`[persona-added] ${agent} (total ${currentSwarm.personas.length})`);
  res.json({ ok: true });
});

// === NEW: add background context, trigger rethink ===
app.post('/events/context-update', (req, res) => {
  const { context, instruction } = req.body || {};
  if (!context) return res.status(400).json({ error: 'context required' });
  const entry = { context, instruction: instruction || '', ts: Date.now() };
  currentSwarm.contextHistory.push(entry);
  io.emit('context-update', entry);
  console.log(`[context-update] ${String(context).substring(0, 60)}...`);
  res.json({ ok: true });
});

app.get('/api/state', (req, res) => res.json(currentSwarm));
app.get('/health', (req, res) => res.json({ ok: true, status: currentSwarm.status }));

app.post('/api/reset', (req, res) => {
  currentSwarm = freshSwarm();
  io.emit('swarm-reset');
  res.json({ ok: true });
});

io.on('connection', (socket) => {
  console.log(`[ws] client connected (${io.engine.clientsCount} total)`);
  socket.emit('state-snapshot', currentSwarm);
  socket.on('disconnect', () => console.log(`[ws] client disconnected (${io.engine.clientsCount} total)`));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🌀 Swarm dashboard server on http://0.0.0.0:${PORT}`);
});
