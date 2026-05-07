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

// In-memory swarm state — lets late-joining browsers replay the current swarm
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
    startedAt: null,
  };
}

// REST endpoints — Claude skill posts events here
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

// State endpoint for late-joining browsers
app.get('/api/state', (req, res) => res.json(currentSwarm));

// Health check
app.get('/health', (req, res) => res.json({ ok: true, status: currentSwarm.status }));

// Reset (manual via curl) — useful for testing
app.post('/api/reset', (req, res) => {
  currentSwarm = freshSwarm();
  io.emit('swarm-reset');
  res.json({ ok: true });
});

io.on('connection', (socket) => {
  console.log(`[ws] client connected (${io.engine.clientsCount} total)`);
  // Send current state immediately so late-joining clients see existing swarm
  socket.emit('state-snapshot', currentSwarm);
  socket.on('disconnect', () => {
    console.log(`[ws] client disconnected (${io.engine.clientsCount} total)`);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🌀 Swarm dashboard server listening on http://0.0.0.0:${PORT}`);
});
