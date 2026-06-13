const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const MAP_PATH = path.join(os.homedir(), '.cloudcli', 'mission-session-map.json');
const PROVIDER_BY_MODEL = {
  opus: 'claude',
  sonnet: 'claude',
  haiku: 'claude',
  'claude-default': 'claude',
  glm: 'claude',
  codex: 'codex',
};

function ensureDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
}

function readJsonSafe(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJson(file, value) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function newRunId() {
  return `r_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
}

function buildMarker(mission, kind, runId) {
  return `MISSION_WORKSPACE_ID=${mission.id}:${mission.planSlug}:${kind}:${runId}`;
}

function withMissionMarker(prompt, marker, mission, kind) {
  return [
    marker,
    '',
    'Mission workspace routing note:',
    `- Source repo root / actual cwd: ${mission.targetProject}`,
    `- Mission workspace for reports/artifacts: ${mission.workspaceRoot}`,
    `- This phase display folder: ${mission.phaseProjectPaths?.[kind] || mission.workspaceRoot}`,
    '- Write source code edits only in the source repo root. Do not create source edits under missions/<plan>/<kind>/apps/...',
    '',
    prompt,
  ].join('\n');
}

function walkJsonl(root, sinceMs, out = []) {
  if (!root || !fs.existsSync(root)) return out;
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      walkJsonl(full, sinceMs, out);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
    try {
      const st = fs.statSync(full);
      if (!sinceMs || st.mtimeMs >= sinceMs || st.ctimeMs >= sinceMs) out.push(full);
    } catch {}
  }
  return out;
}

function parseSessionCandidate(filePath, provider, targetProject, marker) {
  let text = '';
  try { text = fs.readFileSync(filePath, 'utf8'); } catch { return null; }
  const hasMarker = marker && text.includes(marker);
  const lines = text.split(/\r?\n/).filter(Boolean);
  let sessionId = null;
  let cwd = null;
  for (const line of lines) {
    try {
      const data = JSON.parse(line);
      if (!sessionId) {
        sessionId = typeof data.sessionId === 'string' ? data.sessionId : sessionId;
        sessionId = typeof data.session_id === 'string' ? data.session_id : sessionId;
        sessionId = typeof data.payload?.id === 'string' ? data.payload.id : sessionId;
      }
      if (!cwd) {
        cwd = typeof data.cwd === 'string' ? data.cwd : cwd;
        cwd = typeof data.payload?.cwd === 'string' ? data.payload.cwd : cwd;
      }
      if (sessionId && cwd) break;
    } catch {}
  }
  if (!sessionId) {
    const match = text.match(/"sessionId"\s*:\s*"([^"]+)"/) || text.match(/"session_id"\s*:\s*"([^"]+)"/) || text.match(/"id"\s*:\s*"([^"]+)"/);
    sessionId = match ? match[1] : null;
  }
  if (!sessionId) return null;
  return {
    filePath,
    provider,
    sessionId,
    cwd,
    hasMarker,
    cwdMatches: !targetProject || !cwd || path.resolve(cwd) === path.resolve(targetProject),
  };
}

function providerRoots(provider) {
  const home = os.homedir();
  if (provider === 'codex') return [path.join(home, '.codex', 'sessions')];
  return [path.join(home, '.claude', 'projects')];
}

function findSessionCandidates({ provider, targetProject, marker, startedAt }) {
  const sinceMs = Math.max(0, Number(startedAt || Date.now()) - 10_000);
  const files = providerRoots(provider).flatMap((root) => walkJsonl(root, sinceMs));
  const candidates = files
    .map((file) => parseSessionCandidate(file, provider, targetProject, marker))
    .filter(Boolean)
    .filter((item) => item.hasMarker || item.cwdMatches);
  const marked = candidates.filter((item) => item.hasMarker);
  return marked.length ? marked : candidates;
}

function recordMissionSessionMapping({ mission, kind, model, marker, startedAt, logPath }) {
  const provider = PROVIDER_BY_MODEL[model] || 'claude';
  const candidates = findSessionCandidates({ provider, targetProject: mission.targetProject, marker, startedAt });
  if (!candidates.length) {
    const warning = `[mission-map] no transcript found marker=${marker} provider=${provider} kind=${kind}`;
    if (logPath) {
      try { fs.appendFileSync(logPath, `\n${warning}\n`); } catch {}
    }
    return { ok: false, warning };
  }

  const map = readJsonSafe(MAP_PATH, {});
  const displayProjectPath = mission.phaseProjectPaths?.[kind] || path.join(mission.workspaceRoot, kind);
  const displayProjectName = `ORCA MVP / ${mission.title} / ${kind}`;
  for (const candidate of candidates) {
    map[candidate.sessionId] = {
      provider,
      targetProject: mission.targetProject,
      displayProjectPath,
      displayProjectName,
      missionId: mission.id,
      planSlug: mission.planSlug,
      kind,
      transcriptPath: candidate.filePath,
      marker,
      mappedAt: new Date().toISOString(),
    };
  }
  writeJson(MAP_PATH, map);
  return { ok: true, sessionIds: candidates.map((item) => item.sessionId), path: MAP_PATH };
}

module.exports = {
  MAP_PATH,
  buildMarker,
  newRunId,
  recordMissionSessionMapping,
  withMissionMarker,
};
