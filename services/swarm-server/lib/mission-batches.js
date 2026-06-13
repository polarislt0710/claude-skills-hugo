const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { runAgent, CLI_REGISTRY } = require('./mission-agents');

const DATA_DIR = process.env.SWARM_DATA_DIR || path.join(__dirname, '..', 'data');
const BATCHES_PATH = path.join(DATA_DIR, 'mission-batches.json');
const MAX_PLAN_CHARS = Number(process.env.MISSION_BATCH_PLAN_CHARS || 14000);

const FILE_EXTENSIONS = [
  'astro', 'css', 'env', 'html', 'js', 'jsx', 'json', 'md', 'mjs', 'py', 'sql',
  'sh', 'svelte', 'toml', 'ts', 'tsx', 'txt', 'vue', 'yaml', 'yml',
];

function now() {
  return Date.now();
}

function newBatchId() {
  return `batch_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
}

function readJsonSafe(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function readBatchStore() {
  const store = readJsonSafe(BATCHES_PATH, null);
  if (store && Array.isArray(store.batches)) return store;
  return { version: 1, batches: [] };
}

function writeBatchStore(store) {
  writeJson(BATCHES_PATH, {
    version: 1,
    batches: Array.isArray(store.batches) ? store.batches : [],
  });
}

function listBatches() {
  return readBatchStore().batches.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

function getBatch(id) {
  return listBatches().find((batch) => batch.id === id) || null;
}

function saveBatch(batch) {
  const store = readBatchStore();
  const idx = store.batches.findIndex((item) => item.id === batch.id);
  batch.updatedAt = now();
  if (idx >= 0) store.batches[idx] = batch;
  else store.batches.push(batch);
  writeBatchStore(store);
  return batch;
}

function resolveInside(baseDir, candidate) {
  const resolved = path.resolve(candidate);
  const base = path.resolve(baseDir);
  return resolved === base || resolved.startsWith(base + path.sep) ? resolved : null;
}

function readPlanEntries(planPaths, handoffsDir) {
  if (!Array.isArray(planPaths) || planPaths.length === 0) {
    throw new Error('plan_paths required');
  }
  if (planPaths.length > 20) {
    throw new Error('max 20 plans per batch');
  }

  return planPaths.map((rawPath, idx) => {
    const planPath = resolveInside(handoffsDir, String(rawPath || ''));
    if (!planPath) throw new Error(`plan_path must be inside ${handoffsDir}`);
    if (!fs.existsSync(planPath)) throw new Error(`plan does not exist: ${path.basename(planPath)}`);
    const content = fs.readFileSync(planPath, 'utf8');
    const heading = content.match(/^\s*#\s+(.+)$/m);
    return {
      order: idx + 1,
      planPath,
      fileName: path.basename(planPath),
      title: heading ? heading[1].trim().slice(0, 160) : titleFromFile(planPath),
      content,
      excerpt: content.length > MAX_PLAN_CHARS ? content.slice(0, MAX_PLAN_CHARS) + '\n\n...[truncated]' : content,
    };
  });
}

function titleFromFile(planPath) {
  return path.basename(planPath, path.extname(planPath))
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim() || 'Untitled plan';
}

function normalizePredictedFile(filePath, targetProject) {
  let value = String(filePath || '').trim();
  value = value.replace(/^[`'"(<\[]+|[`'"),>\].:;]+$/g, '');
  value = value.replace(/\\/g, '/');
  if (!value || value.startsWith('http://') || value.startsWith('https://')) return null;

  const target = targetProject ? path.resolve(targetProject) : null;
  if (path.isAbsolute(value) && target) {
    const resolved = path.resolve(value);
    if (resolved === target) return null;
    if (resolved.startsWith(target + path.sep)) value = path.relative(target, resolved).replace(/\\/g, '/');
  }
  value = value.replace(/^\.\/+/, '').replace(/^\/+/, '');
  if (!value || value.includes('..')) return null;
  if (/(^|\/)(node_modules|\.git|\.next|dist|build|coverage|missions)(\/|$)/.test(value)) return null;
  return value;
}

function extractFilePaths(text, targetProject) {
  const ext = FILE_EXTENSIONS.join('|');
  const fileRe = new RegExp(
    String.raw`(?:^|[\s("'` + '`' + String.raw`])((?:(?:~|\.{1,2}|/)?(?:[A-Za-z0-9_@.+:-]+/))*[A-Za-z0-9_@.+:-]+\.(` + ext + String.raw`))(?:[:\s)"'` + '`' + String.raw`,]|$)`,
    'g'
  );
  const found = new Set();
  let match;
  while ((match = fileRe.exec(text)) !== null) {
    const normalized = normalizePredictedFile(match[1], targetProject);
    if (normalized) found.add(normalized);
    if (found.size >= 80) break;
  }
  return Array.from(found).sort();
}

function computeCollisionGroups(items) {
  const fileToItems = new Map();
  for (const item of items) {
    for (const file of item.predictedFiles || []) {
      if (!fileToItems.has(file)) fileToItems.set(file, new Set());
      fileToItems.get(file).add(item.planPath);
    }
  }

  const overlaps = Array.from(fileToItems.entries())
    .filter(([, plans]) => plans.size > 1)
    .map(([file, plans]) => ({ file, planPaths: Array.from(plans).sort() }))
    .sort((a, b) => a.file.localeCompare(b.file));

  const graph = new Map();
  for (const item of items) graph.set(item.planPath, new Set());
  for (const overlap of overlaps) {
    for (const a of overlap.planPaths) {
      for (const b of overlap.planPaths) {
        if (a !== b) graph.get(a).add(b);
      }
    }
  }

  let groupNo = 1;
  const visited = new Set();
  const groupByPlan = new Map();
  for (const item of items) {
    if (visited.has(item.planPath) || graph.get(item.planPath).size === 0) continue;
    const groupId = `cg-${groupNo++}`;
    const stack = [item.planPath];
    visited.add(item.planPath);
    while (stack.length) {
      const current = stack.pop();
      groupByPlan.set(current, groupId);
      for (const next of graph.get(current) || []) {
        if (!visited.has(next)) {
          visited.add(next);
          stack.push(next);
        }
      }
    }
  }

  return { overlaps, groupByPlan };
}

function deterministicAnalysis(entries, targetProject, note = 'deterministic fallback') {
  const items = entries.map((entry, idx) => ({
    order: idx + 1,
    planPath: entry.planPath,
    fileName: entry.fileName,
    title: entry.title,
    predictedFiles: extractFilePaths(entry.content, targetProject),
    dependencies: [],
    reason: idx === 0 ? '第一個選擇嘅 plan，照使用者順序開始。' : '照使用者選擇順序排隊。',
    collisionGroup: null,
    linkedMissionId: null,
    status: 'queued',
  }));
  const collisions = computeCollisionGroups(items);
  for (const item of items) {
    item.collisionGroup = collisions.groupByPlan.get(item.planPath) || null;
  }
  return {
    planner: 'deterministic',
    note,
    targetProject,
    generatedAt: now(),
    items,
    collisions: collisions.overlaps,
  };
}

function extractJsonObject(text) {
  const raw = String(text || '').trim();
  if (!raw) throw new Error('empty planner output');
  try {
    return JSON.parse(raw);
  } catch {}
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced) return JSON.parse(fenced[1]);
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) return JSON.parse(raw.slice(start, end + 1));
  throw new Error('no JSON object found');
}

function sanitizeAiAnalysis(ai, fallback, entries, targetProject) {
  const byPath = new Map(entries.map((entry) => [entry.planPath, entry]));
  const fallbackByPath = new Map(fallback.items.map((item) => [item.planPath, item]));
  const rawItems = Array.isArray(ai.items) ? ai.items : Array.isArray(ai.order) ? ai.order : [];
  const ordered = [];
  const seen = new Set();

  for (const raw of rawItems) {
    const rawPath = raw.planPath || raw.plan_path || raw.path;
    const entry = byPath.get(rawPath);
    if (!entry || seen.has(entry.planPath)) continue;
    const base = fallbackByPath.get(entry.planPath);
    const predicted = Array.isArray(raw.predictedFiles || raw.predicted_files)
      ? (raw.predictedFiles || raw.predicted_files)
          .map((file) => normalizePredictedFile(file, targetProject))
          .filter(Boolean)
      : [];
    ordered.push({
      ...base,
      predictedFiles: Array.from(new Set([...(base.predictedFiles || []), ...predicted])).sort(),
      dependencies: Array.isArray(raw.dependencies) ? raw.dependencies.map(String).slice(0, 10) : [],
      reason: String(raw.reason || raw.dependencyReason || raw.dependency_reason || base.reason || '').slice(0, 500),
    });
    seen.add(entry.planPath);
  }

  for (const item of fallback.items) {
    if (!seen.has(item.planPath)) ordered.push({ ...item });
  }

  ordered.forEach((item, idx) => { item.order = idx + 1; });
  const collisions = computeCollisionGroups(ordered);
  for (const item of ordered) {
    item.collisionGroup = collisions.groupByPlan.get(item.planPath) || null;
  }

  return {
    planner: 'sonnet',
    note: String(ai.note || ai.summary || 'Sonnet batch analysis').slice(0, 1000),
    targetProject,
    generatedAt: now(),
    items: ordered,
    collisions: collisions.overlaps,
  };
}

function buildPlannerPrompt(entries, fallback, targetProject) {
  const compact = entries.map((entry, idx) => ({
    index: idx + 1,
    planPath: entry.planPath,
    title: entry.title,
    regexPredictedFiles: fallback.items[idx].predictedFiles,
    excerpt: entry.excerpt,
  }));

  return [
    'You are Mission Batch Planner for Mission Control.',
    'Analyze several handoff plans that will run against the same repo.',
    'Return JSON only. No markdown.',
    '',
    `Target project: ${targetProject}`,
    '',
    'Rules:',
    '- Recommend a safe serial execution order.',
    '- Dependencies must reference planPath values from the input only.',
    '- predictedFiles should be repo-relative paths when possible.',
    '- Collision warnings are advisory only; execution will still be serial.',
    '',
    'Required JSON shape:',
    '{"items":[{"planPath":"...","reason":"...","dependencies":["..."],"predictedFiles":["..."]}],"note":"..."}',
    '',
    'Plans:',
    JSON.stringify(compact, null, 2),
  ].join('\n');
}

async function analyzeBatch(opts) {
  const {
    planPaths,
    handoffsDir,
    targetProject,
    plannerModel = 'gpt-5.5',
    useAi = process.env.MISSION_BATCH_ANALYSIS_AI !== 'off',
  } = opts || {};

  const entries = readPlanEntries(planPaths, handoffsDir);
  const fallback = deterministicAnalysis(entries, targetProject);
  if (!useAi || !CLI_REGISTRY[plannerModel]) return fallback;

  try {
    const result = await runAgent({
      model: plannerModel,
      cwd: targetProject && fs.existsSync(targetProject) ? targetProject : process.cwd(),
      prompt: buildPlannerPrompt(entries, fallback, targetProject),
      timeoutMs: Number(process.env.MISSION_BATCH_ANALYSIS_TIMEOUT_MS || 120000),
    });
    if (result.exitCode !== 0) throw new Error(`planner exited ${result.exitCode}`);
    return sanitizeAiAnalysis(extractJsonObject(result.stdout), fallback, entries, targetProject);
  } catch (err) {
    return deterministicAnalysis(entries, targetProject, `AI batch analysis failed; fallback used: ${err.message}`);
  }
}

function dirtyProjectStatus(targetProject) {
  try {
    const status = execFileSync('git', ['-C', targetProject, 'status', '--short'], {
      encoding: 'utf8',
      maxBuffer: 2 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return {
      dirty: !!status,
      status,
      files: status ? status.split('\n').filter(Boolean).slice(0, 120) : [],
    };
  } catch (err) {
    return { dirty: false, status: '', files: [], error: err.message };
  }
}

module.exports = {
  analyzeBatch,
  dirtyProjectStatus,
  getBatch,
  listBatches,
  newBatchId,
  readBatchStore,
  saveBatch,
};
