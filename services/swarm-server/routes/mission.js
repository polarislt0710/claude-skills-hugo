// Mission Controller v2 — handoff-driven multi-phase pipeline
//   coding (GLM 5.2 default) → review (Opus + guidelines) → refill (Opus)
// New missions get a display workspace under <targetProject>/missions/<plan-slug>/.
// State persisted to disk so swarm-server restart doesn't lose progress.

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');
const { runAgent, parseFileBlocks, CLI_REGISTRY } = require('../lib/mission-agents');
const {
  analyzeBatch,
  dirtyProjectStatus,
  getBatch,
  listBatches,
  newBatchId,
  saveBatch,
} = require('../lib/mission-batches');
const {
  ROLE_CATALOG,
  buildIntelligence,
  mergeModelsWithRoute,
  applyResolvedModelsToIntelligence,
} = require('../lib/mission-intelligence');
const { runAutoOrchestrator, resumeAutoOrchestrator, findResumeCheckpoint } = require('../lib/mission-orchestrator');
const {
  buildMarker,
  newRunId,
  recordMissionSessionMapping,
  withMissionMarker,
} = require('../lib/mission-session-map');
const {
  diffProjectSnapshots,
  mergeTouchedFiles,
  snapshotProject,
} = require('../lib/project-snapshot');

const HANDOFFS_DIR    = process.env.HANDOFFS_DIR    || path.join(process.env.HOME || '/home/hugo-orca', 'handoffs');
const GUIDELINES_DIR  = process.env.GUIDELINES_DIR  || path.join(process.env.HOME || '/home/hugo-orca', 'guidelines');
const MISSIONS_ROOT   = process.env.MISSIONS_ROOT   || path.join(process.env.HOME || '/home/hugo-orca', 'missions');
const DEFAULT_PROJECT = process.env.MISSION_DEFAULT_PROJECT || path.join(process.env.HOME || '/home/hugo-orca', 'orca-platform-mvp');
const MISSION_INDEX_PATH = path.join(__dirname, '..', 'data', 'mission-index.json');

try { fs.mkdirSync(MISSIONS_ROOT, { recursive: true }); } catch {}
try { fs.mkdirSync(GUIDELINES_DIR, { recursive: true }); } catch {}
try { fs.mkdirSync(HANDOFFS_DIR, { recursive: true }); } catch {}
try { fs.mkdirSync(path.dirname(MISSION_INDEX_PATH), { recursive: true }); } catch {}

const PHASE_ORDER = ['coding', 'review', 'refill'];
const ACTIVE_MISSION_STATUSES = new Set(['preflight', 'planning', 'executing', 'summarizing', 'running']);
const PROMPT_DIR = path.join(__dirname, '..', 'prompts');
const SYS_PROMPTS = {
  coding: fs.readFileSync(path.join(PROMPT_DIR, 'mission-coding-system.md'), 'utf8'),
  refill: fs.readFileSync(path.join(PROMPT_DIR, 'mission-refill-system.md'), 'utf8'),
  review: fs.readFileSync(path.join(PROMPT_DIR, 'mission-review-system.md'), 'utf8'),
  contextScout: fs.readFileSync(path.join(PROMPT_DIR, 'mission-context-scout-system.md'), 'utf8'),
  planner: fs.readFileSync(path.join(PROMPT_DIR, 'mission-planner-system.md'), 'utf8'),
  fixIteration: fs.readFileSync(path.join(PROMPT_DIR, 'mission-fix-iteration.md'), 'utf8'),
  finalSummary: fs.readFileSync(path.join(PROMPT_DIR, 'mission-final-summary-system.md'), 'utf8'),
};

function newId() {
  return `m_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
}
function slug(s) {
  return String(s || 'mission').toLowerCase().replace(/[^a-z0-9一-龥]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'mission';
}
function writeJson(p, o) { fs.writeFileSync(p, JSON.stringify(o, null, 2)); }
function readJsonSafe(p, fallback) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; } }
function appendLine(p, line) { fs.appendFileSync(p, line + '\n'); }
function ensureDir(d) { fs.mkdirSync(d, { recursive: true }); }

function titleCaseFromSlug(value) {
  return String(value || 'mission')
    .split('-')
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(' ');
}

function readMissionIndex() {
  return readJsonSafe(MISSION_INDEX_PATH, {});
}

function writeMissionIndex(index) {
  writeJson(MISSION_INDEX_PATH, index);
}

function registerMissionDir(id, dir) {
  const index = readMissionIndex();
  index[id] = dir;
  writeMissionIndex(index);
}

function unregisterMissionDir(id) {
  const index = readMissionIndex();
  delete index[id];
  writeMissionIndex(index);
}

function phaseProjectPaths(workspaceRoot) {
  return {
    coding: path.join(workspaceRoot, 'coding'),
    review: path.join(workspaceRoot, 'review'),
    refill: path.join(workspaceRoot, 'refill'),
    summary: path.join(workspaceRoot, 'summary'),
  };
}

function allocateMissionWorkspace(targetProject, title) {
  const missionsBase = path.join(targetProject, 'missions');
  ensureDir(missionsBase);
  const baseSlug = slug(title);
  let planSlug = baseSlug;
  let workspaceRoot = path.join(missionsBase, planSlug);
  let n = 2;
  while (fs.existsSync(workspaceRoot)) {
    planSlug = `${baseSlug}-${n}`;
    workspaceRoot = path.join(missionsBase, planSlug);
    n += 1;
  }
  ensureDir(workspaceRoot);
  const paths = phaseProjectPaths(workspaceRoot);
  for (const dir of Object.values(paths)) ensureDir(dir);
  ensureDir(path.join(workspaceRoot, 'artifacts'));
  ensureDir(path.join(workspaceRoot, 'artifacts', 'internal'));
  return { planSlug, workspaceRoot, phaseProjectPaths: paths };
}

function scanMissionStates(root, legacyOnly = false) {
  if (!root || !fs.existsSync(root)) return [];
  try {
    return fs.readdirSync(root)
      .map((d) => {
        const dir = path.join(root, d);
        const st = readJsonSafe(path.join(dir, 'state.json'), null);
        if (!st || !st.id) return null;
        return { dir, state: { ...st, legacy: legacyOnly || st.legacy || false } };
      })
      .filter(Boolean);
  } catch { return []; }
}

function listHandoffs() {
  try {
    return fs.readdirSync(HANDOFFS_DIR)
      .filter((f) => /\.(md|txt)$/i.test(f))
      .map((f) => {
        const full = path.join(HANDOFFS_DIR, f);
        const st = fs.statSync(full);
        return { name: f, path: full, mtime: st.mtimeMs, size: st.size };
      })
      .sort((a, b) => b.mtime - a.mtime);
  } catch { return []; }
}
function listGuidelines() {
  try {
    return fs.readdirSync(GUIDELINES_DIR)
      .filter((f) => /\.md$/i.test(f))
      .map((f) => {
        const full = path.join(GUIDELINES_DIR, f);
        const st = fs.statSync(full);
        return { name: f, path: full, mtime: st.mtimeMs, size: st.size };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch { return []; }
}

// Snapshot git HEAD of target project at mission creation, so refill/review
// can diff against it later. Returns null if not a git repo.
function snapshotGitHead(targetProject) {
  try {
    return execSync(`git -C "${targetProject}" rev-parse HEAD 2>/dev/null`, { encoding: 'utf8' }).trim() || null;
  } catch { return null; }
}

// Gather what changed in target project between startCommit and HEAD.
// Returns null if no startCommit or no diff.
function gatherProjectChanges(targetProject, startCommit) {
  if (!targetProject || !startCommit) return null;
  try {
    const safe = (cmd) => {
      try { return execSync(cmd, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }); } catch { return ''; }
    };
    const log         = safe(`git -C "${targetProject}" log --oneline ${startCommit}..HEAD 2>/dev/null`).trim();
    const namesAdded  = safe(`git -C "${targetProject}" diff --name-only ${startCommit}..HEAD 2>/dev/null`).trim();
    const diffStat    = safe(`git -C "${targetProject}" diff --stat ${startCommit}..HEAD 2>/dev/null`).trim();
    const status      = safe(`git -C "${targetProject}" status --short 2>/dev/null`).trim();
    const headSha     = safe(`git -C "${targetProject}" rev-parse HEAD 2>/dev/null`).trim();
    return { log, namesAdded, diffStat, status, headSha };
  } catch { return null; }
}

function listMissions() {
  const index = readMissionIndex();
  const indexed = Object.values(index)
    .map((dir) => {
      const st = readJsonSafe(path.join(dir, 'state.json'), null);
      return st && st.id ? { dir, state: st } : null;
    })
    .filter(Boolean);
  const defaultProjectMissions = scanMissionStates(path.join(DEFAULT_PROJECT, 'missions'));
  const legacyMissions = scanMissionStates(MISSIONS_ROOT, true);
  const byId = new Map();
  for (const item of [...legacyMissions, ...defaultProjectMissions, ...indexed]) {
    byId.set(item.state.id, item.state);
  }
  return Array.from(byId.values())
    .map((st) => ({
      id: st.id,
      title: st.title,
      status: st.status,
      currentPhase: st.currentPhase,
      targetProject: st.targetProject,
      workspaceRoot: st.workspaceRoot,
      planSlug: st.planSlug,
      phaseProjectPaths: st.phaseProjectPaths,
      actualTouchedFiles: st.actualTouchedFiles || [],
      batchId: st.batchId || null,
      batchItemId: st.batchItemId || null,
      smartRoute: !!st.smartRoute,
      warningPolicy: st.warningPolicy || null,
      contextScout: st.contextScout || null,
      promptActiveRoleKeys: st.promptActiveRoleKeys || [],
      intelligence: st.intelligence ? {
        complexity: st.intelligence.complexity,
        route: st.intelligence.route,
        tokenBudget: st.intelligence.tokenBudget,
        roster: Array.isArray(st.intelligence.roster) ? st.intelligence.roster : [],
      } : null,
      legacy: !!st.legacy,
      createdAt: st.createdAt,
      updatedAt: st.updatedAt,
    }))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

function missionDir(id) {
  const index = readMissionIndex();
  if (index[id] && fs.existsSync(index[id])) return index[id];
  const candidates = [
    ...scanMissionStates(path.join(DEFAULT_PROJECT, 'missions')),
    ...scanMissionStates(MISSIONS_ROOT, true),
  ];
  const found = candidates.find((item) => item.state.id === id);
  if (found) return found.dir;
  return path.join(MISSIONS_ROOT, id);
}
function statePath(id) { return path.join(missionDir(id), 'state.json'); }
function transcriptPath(id, phase) { return path.join(missionDir(id), `phase-${phase}`, 'transcript.log'); }
function artifactsDir(id, phase) { return path.join(missionDir(id), `phase-${phase}`, 'artifacts'); }

const projectLocks = new Map();

function projectKey(projectPath) {
  return path.resolve(String(projectPath || DEFAULT_PROJECT));
}

function isActiveMissionStatus(status) {
  return ACTIVE_MISSION_STATUSES.has(status);
}

function findBusyMission(targetProject, excludeId = null) {
  const key = projectKey(targetProject);
  const lockedBy = projectLocks.get(key);
  if (lockedBy && lockedBy !== excludeId) return { id: lockedBy, source: 'lock' };

  for (const mission of listMissions()) {
    if (mission.id === excludeId) continue;
    if (projectKey(mission.targetProject || DEFAULT_PROJECT) !== key) continue;
    if (isActiveMissionStatus(mission.status)) return { id: mission.id, source: 'state' };
  }
  return null;
}

function acquireProjectLock(targetProject, missionId) {
  const busy = findBusyMission(targetProject, missionId);
  if (busy) return { ok: false, busyMissionId: busy.id, source: busy.source };
  projectLocks.set(projectKey(targetProject), missionId);
  return { ok: true };
}

function releaseProjectLock(targetProject, missionId) {
  const key = projectKey(targetProject);
  if (projectLocks.get(key) === missionId) projectLocks.delete(key);
}

function compactSnapshotMeta(snapshot) {
  return {
    capturedAt: snapshot && snapshot.capturedAt,
    durationMs: snapshot && snapshot.durationMs,
    fileCount: snapshot && snapshot.files ? Object.keys(snapshot.files).length : 0,
    error: snapshot && snapshot.error,
  };
}

function recordMissionFileChanges(mission, entry) {
  if (!mission.fileChanges) mission.fileChanges = [];
  mission.fileChanges.push(entry);
  if (mission.fileChanges.length > 200) mission.fileChanges = mission.fileChanges.slice(-200);
  mission.actualTouchedFiles = mergeTouchedFiles(mission.actualTouchedFiles, entry.changes);
}

function assertPlanPath(planPath) {
  const resolved = path.resolve(String(planPath || ''));
  const base = path.resolve(HANDOFFS_DIR);
  if (!(resolved === base || resolved.startsWith(base + path.sep))) {
    throw new Error(`plan_path must be inside ${HANDOFFS_DIR}`);
  }
  if (!fs.existsSync(resolved)) throw new Error('plan_path does not exist');
  return resolved;
}

// ─── Phase runner ──────────────────────────────────────────────────────
async function runPhase(io, mission, phase) {
  const id = mission.id;
  const dir = missionDir(id);
  const tPath = transcriptPath(id, phase);
  const artDir = artifactsDir(id, phase);
  ensureDir(path.dirname(tPath));
  ensureDir(artDir);

  const room = `mission-${id}`;
  io.to(room).emit('mission:phase-start', { id, phase, model: mission.models[phase] });
  mission.status = 'running';
  mission.currentPhase = phase;
  mission.updatedAt = Date.now();
  writeJson(statePath(id), mission);

  // Build prompt
  const plan = fs.readFileSync(path.join(dir, 'plan.md'), 'utf8');
  let prompt = SYS_PROMPTS[phase];
  prompt += `\n\n---\n\n# Plan\n\n${plan}\n\n---\n\n`;
  prompt += `Project root for outputs: ${mission.targetProject}\n\n`;

  if (phase !== 'coding') {
    // Two sources of "what changed":
    //   1. Files coding agent emitted as ```file:``` blocks (artifacts/)
    //   2. Files coding agent wrote directly via Write tool, captured via git diff
    // Modern agents (Claude with bypassPermissions) overwhelmingly use path #2.
    const previousArtifacts = collectArtifacts(id);
    if (previousArtifacts.length > 0) {
      prompt += '# Previous artifacts (from `file:` blocks)\n\n';
      for (const a of previousArtifacts) {
        prompt += `===== FILE: ${a.path} =====\n${a.content}\n\n`;
      }
    }

    const gitChanges = gatherProjectChanges(mission.targetProject, mission.startCommit);
    if (gitChanges && (gitChanges.namesAdded || gitChanges.status)) {
      prompt += '# Changes in target project (via git)\n\n';
      prompt += `Project root: ${mission.targetProject}\n`;
      prompt += `Mission baseline commit: ${mission.startCommit || '(unknown)'}\n`;
      prompt += `Current HEAD: ${gitChanges.headSha || '(unknown)'}\n\n`;
      if (gitChanges.log) prompt += `## Commits made by previous phase(s)\n\n\`\`\`\n${gitChanges.log}\n\`\`\`\n\n`;
      if (gitChanges.namesAdded) prompt += `## Files modified / added\n\n\`\`\`\n${gitChanges.namesAdded}\n\`\`\`\n\n`;
      if (gitChanges.diffStat) prompt += `## Diff stat\n\n\`\`\`\n${gitChanges.diffStat}\n\`\`\`\n\n`;
      if (gitChanges.status) prompt += `## Uncommitted changes (working tree)\n\n\`\`\`\n${gitChanges.status}\n\`\`\`\n\n`;
      prompt += `**Use the Read tool to inspect any file's full content** — your cwd is set to ${mission.targetProject}. ` +
                `Do NOT assume "no artifacts" means nothing happened — check the git log + Read the modified files.\n\n`;
    } else if (previousArtifacts.length === 0) {
      prompt += '# No artifacts AND no git changes detected\n\n' +
                'Previous phase produced no `file:` blocks and made no git commits or working-tree changes. ' +
                'Either the previous phase truly did nothing, or it failed silently. ' +
                'You may use Read/Bash tools to investigate the target project state if useful.\n\n';
    }
  }

  // Inject `~/guidelines/*.md` as "Global Rules" for ALL phases.
  // Coding: follow them while writing code.
  // Refill: enforce them while polishing.
  // Review: check artifacts against them.
  const guidelineFiles = listGuidelines();
  if (guidelineFiles.length > 0) {
    prompt += '\n# Global Rules（來自 ~/guidelines/）\n\n';
    prompt += '呢度係 universal rules，跨所有 phase 都適用。請逐條 honour。\n\n';
    for (const g of guidelineFiles) {
      const content = fs.readFileSync(g.path, 'utf8');
      prompt += `===== RULE FILE: ${g.name} =====\n${content}\n\n`;
    }
  }

  // Run agent with line streaming
  const start = Date.now();
  const beforeSnapshot = snapshotProject(mission.targetProject);
  const runId = newRunId();
  const marker = buildMarker(mission, phase, runId);
  prompt = withMissionMarker(prompt, marker, mission, phase);
  fs.writeFileSync(tPath, `# Phase: ${phase}\n# Kind: ${phase}\n# Model: ${mission.models[phase]}\n# Marker: ${marker}\n# Started: ${new Date().toISOString()}\n\n`);

  // Progress poller — observes git + filesystem every 5s, emits mission:progress.
  // Works for ANY agent (claude/glm/codex) since it watches external state.
  let lastTouchedSig = '';
  const poller = setInterval(() => {
    try {
      const safe = (cmd) => {
        try { return execSync(cmd, { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 }).trim(); } catch { return ''; }
      };
      const proj = mission.targetProject;
      const base = mission.startCommit;
      const commits = base ? safe(`git -C "${proj}" log --oneline ${base}..HEAD 2>/dev/null`) : '';
      const status = safe(`git -C "${proj}" status --short 2>/dev/null`);
      const recentList = safe(
        `find "${proj}" -type f -mmin -1 ` +
        `! -path '*/node_modules/*' ! -path '*/.git/*' ! -path '*/.next/*' ` +
        `! -path '*/__pycache__/*' ! -path '*/.tmp/*' ` +
        `-printf '%TT %p\\n' 2>/dev/null | sort -r | head -10 | awk '{print $2}'`
      );
      const commitCount = commits ? commits.split('\n').filter(Boolean).length : 0;
      const modifiedCount = status ? status.split('\n').filter(Boolean).length : 0;
      const recentFiles = recentList ? recentList.split('\n').filter(Boolean).map((p) => p.replace(proj + '/', '')) : [];

      // Probe claude subprocess CPU/elapsed (best-effort)
      let cpuInfo = '';
      try {
        const ps = safe(`ps -C claude -o pid=,etime=,time=,pcpu=,pmem= 2>/dev/null | head -3`);
        cpuInfo = ps;
      } catch {}

      const sig = `${commitCount}:${modifiedCount}:${recentFiles.join(',')}`;
      const changed = sig !== lastTouchedSig;
      lastTouchedSig = sig;

      io.to(room).emit('mission:progress', {
        id, phase,
        elapsedMs: Date.now() - start,
        commitsMade: commitCount,
        latestCommit: commits.split('\n')[0] || null,
        workingTreeModified: modifiedCount,
        recentFiles,
        cpuInfo,
        changed,  // true if anything moved since last poll
        ts: Date.now(),
      });
    } catch (e) {
      // swallow — poller must never crash the phase
    }
  }, 5000);

  let result;
  try {
    result = await runAgent({
      model: mission.models[phase],
      prompt,
      cwd: mission.targetProject,
      onLine: (line) => {
        appendLine(tPath, line);
        io.to(room).emit('mission:line', { id, phase, line });
      },
      onErr: (chunk) => {
        appendLine(tPath, '[stderr] ' + chunk.trimEnd());
        io.to(room).emit('mission:err', { id, phase, chunk });
      },
    });
  } catch (err) {
    clearInterval(poller);
    fs.appendFileSync(tPath, `\n\n# ERROR\n${err.message}\n`);
    mission.status = 'error';
    mission.error = err.message;
    mission.updatedAt = Date.now();
    writeJson(statePath(id), mission);
    io.to(room).emit('mission:error', { id, phase, error: err.message });
    throw err;
  }

  clearInterval(poller);
  fs.appendFileSync(tPath, `\n\n# Completed: ${new Date().toISOString()}\n# Exit: ${result.exitCode}\n# Duration: ${result.durationMs}ms\n`);
  const mapping = recordMissionSessionMapping({ mission, kind: phase, model: mission.models[phase], marker, startedAt: start, logPath: tPath });
  if (mapping.ok) {
    fs.appendFileSync(tPath, `# Session mapping: ${mapping.sessionIds.join(', ')}\n`);
  }

  // Parse file blocks → save to artifacts/
  const blocks = parseFileBlocks(result.stdout);
  for (const b of blocks) {
    const out = path.join(artDir, b.path);
    ensureDir(path.dirname(out));
    fs.writeFileSync(out, b.content);
  }
  // Save raw stdout too for debugging
  fs.writeFileSync(path.join(missionDir(id), `phase-${phase}`, 'raw-output.txt'), result.stdout);

  const afterSnapshot = snapshotProject(mission.targetProject);
  const changes = diffProjectSnapshots(beforeSnapshot, afterSnapshot);
  recordMissionFileChanges(mission, {
    phase,
    workspaceKind: phase,
    startedAt: start,
    finishedAt: Date.now(),
    before: compactSnapshotMeta(beforeSnapshot),
    after: compactSnapshotMeta(afterSnapshot),
    changes,
  });

  mission.phases[phase] = {
    model: mission.models[phase],
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    fileCount: blocks.length,
    touchedFiles: changes.touchedFiles,
    finishedAt: Date.now(),
  };
  mission.updatedAt = Date.now();
  writeJson(statePath(id), mission);

  io.to(room).emit('mission:phase-end', {
    id,
    phase,
    fileCount: blocks.length,
    durationMs: result.durationMs,
    exitCode: result.exitCode,
    fileChanges: changes,
  });
}

function collectArtifacts(missionId) {
  // Returns latest version of each file across all phases (later phases override earlier)
  const accum = new Map();
  for (const phase of PHASE_ORDER) {
    const artDir = artifactsDir(missionId, phase);
    if (!fs.existsSync(artDir)) continue;
    walk(artDir, '', (relPath, content) => {
      accum.set(relPath, content);
    });
  }
  return Array.from(accum.entries()).map(([p, content]) => ({ path: p, content }));
}

function walk(dir, prefix, cb) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) walk(full, rel, cb);
    else if (entry.isFile()) {
      try {
        cb(rel, fs.readFileSync(full, 'utf8'));
      } catch {}
    }
  }
}

async function runPipeline(io, mission, startFromPhase) {
  const startIdx = PHASE_ORDER.indexOf(startFromPhase || 'coding');
  for (let i = startIdx; i < PHASE_ORDER.length; i++) {
    const phase = PHASE_ORDER[i];
    if (mission.skipPhases && mission.skipPhases.includes(phase)) continue;
    try {
      await runPhase(io, mission, phase);
    } catch {
      return;
    }
  }
  mission.status = 'done';
  mission.currentPhase = null;
  mission.updatedAt = Date.now();
  writeJson(statePath(mission.id), mission);

  // Compose final-report.md from review's findings.md (if exists)
  const reviewFindings = path.join(artifactsDir(mission.id, 'review'), 'findings.md');
  if (fs.existsSync(reviewFindings)) {
    const report = fs.readFileSync(reviewFindings, 'utf8');
    fs.writeFileSync(path.join(missionDir(mission.id), 'final-report.md'), report);
  }
  io.to(`mission-${mission.id}`).emit('mission:done', { id: mission.id });
}

function createMissionFromPlan(opts = {}) {
  const {
    plan_path,
    models,
    target_project,
    title,
    skip_phases,
    auto_orchestrate,
    smart_route,
    warning_policy,
    batchId,
    batchItemId,
  } = opts;
  const planPath = assertPlanPath(plan_path);
  const planContent = fs.readFileSync(planPath, 'utf8');
  const baseName = path.basename(planPath, path.extname(planPath));
  const id = newId();
  const targetProj = target_project || DEFAULT_PROJECT;
  const missionTitle = title || titleCaseFromSlug(baseName);
  const intelligenceBase = buildIntelligence(planContent, { title: missionTitle, targetProject: targetProj });
  const resolvedModels = mergeModelsWithRoute(models, intelligenceBase.route, smart_route !== false);
  const intelligence = applyResolvedModelsToIntelligence(intelligenceBase, resolvedModels);
  const workspace = allocateMissionWorkspace(targetProj, missionTitle || baseName);
  const autoFlag = auto_orchestrate !== false;
  const mission = {
    id,
    title: missionTitle,
    planSlug: workspace.planSlug,
    planPath,
    targetProject: targetProj,
    workspaceRoot: workspace.workspaceRoot,
    phaseProjectPaths: workspace.phaseProjectPaths,
    startCommit: snapshotGitHead(targetProj),
    autoOrchestrate: autoFlag,
    smartRoute: smart_route !== false,
    warningPolicy: warning_policy || process.env.MISSION_WARNING_POLICY || 'strict',
    requestedModels: {
      contextScout: (models && models.contextScout) || (models && models.planner) || 'gpt-5.5',
      coding: (models && models.coding) || 'gpt-5.5',
      codingFallback: (models && models.codingFallback) || 'glm-5.2',
      refill: (models && models.refill) || 'opus',
      review: (models && models.review) || 'opus',
      planner: (models && models.planner) || 'gpt-5.5',
      finalSummary: (models && models.finalSummary) || 'opus',
    },
    models: resolvedModels,
    intelligence,
    skipPhases: skip_phases || [],
    status: 'queued',
    currentPhase: null,
    phases: {},
    subPhases: [],
    currentSubPhaseIdx: null,
    plannerNotes: '',
    contextScout: null,
    planner: null,
    finalSummary: null,
    promptActiveRoleKeys: [],
    fileChanges: [],
    actualTouchedFiles: [],
    batchId: batchId || null,
    batchItemId: batchItemId || null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  for (const [ph, m] of Object.entries(mission.models)) {
    if (!CLI_REGISTRY[m]) throw new Error(`unknown model for ${ph}: ${m}`);
  }

  const actualDir = workspace.workspaceRoot;
  registerMissionDir(id, actualDir);
  fs.writeFileSync(path.join(actualDir, 'PLAN.md'), planContent);
  fs.writeFileSync(path.join(actualDir, 'plan.md'), planContent);
  writeJson(path.join(actualDir, '.mission.json'), {
    missionId: id,
    title: mission.title,
    planSlug: mission.planSlug,
    targetProject: mission.targetProject,
    batchId: mission.batchId,
    batchItemId: mission.batchItemId,
    createdAt: new Date(mission.createdAt).toISOString(),
    phaseProjectPaths: mission.phaseProjectPaths,
  });
  writeJson(statePath(id), mission);
  return mission;
}

function startMissionJobNow(mission, job, onSettled = null) {
  const lock = acquireProjectLock(mission.targetProject, mission.id);
  if (!lock.ok) {
    return { started: false, busyMissionId: lock.busyMissionId };
  }

  setImmediate(async () => {
    let error = null;
    try {
      await job();
    } catch (err) {
      error = err;
      console.error('[mission:start]', err.message);
    } finally {
      releaseProjectLock(mission.targetProject, mission.id);
      if (onSettled) {
        try { onSettled(mission, error); } catch (err) { console.error('[mission:onSettled]', err.message); }
      }
    }
  });

  return { started: true };
}

function startMissionNow(io, mission, startFromPhase = 'coding', onSettled = null) {
  return startMissionJobNow(mission, async () => {
    if (mission.autoOrchestrate) {
      const saveState = () => { mission.updatedAt = Date.now(); writeJson(statePath(mission.id), mission); };
      const run = ['paused_for_human', 'error'].includes(mission.status)
        ? resumeAutoOrchestrator
        : runAutoOrchestrator;
      await run({
        io, mission,
        missionDir: missionDir(mission.id),
        sysPrompts: SYS_PROMPTS,
        listGuidelines,
        saveState,
      });
    } else {
      await runPipeline(io, mission, startFromPhase);
    }
  }, onSettled);
}

// ─── Factory ───────────────────────────────────────────────────────────
module.exports = function createMissionRouter(io) {
  const router = express.Router();
  let batchRunnerScheduled = false;

  function emitBatch(batch) {
    io.emit('mission:batch-update', { batch });
  }

  function batchSummary(batch) {
    return {
      ...batch,
      items: (batch.items || []).map((item) => ({
        id: item.id,
        order: item.order,
        planPath: item.planPath,
        fileName: item.fileName,
        title: item.title,
        predictedFiles: item.predictedFiles || [],
        actualTouchedFiles: item.actualTouchedFiles || [],
        dependencies: item.dependencies || [],
        reason: item.reason || '',
        collisionGroup: item.collisionGroup || null,
        linkedMissionId: item.linkedMissionId || null,
        linkedMissionStatus: item.linkedMissionStatus || null,
        status: item.status,
        startedAt: item.startedAt || null,
        finishedAt: item.finishedAt || null,
        error: item.error || null,
      })),
    };
  }

  function refreshRunningBatchItem(batch) {
    const item = (batch.items || []).find((candidate) => candidate.status === 'running');
    if (!item || !item.linkedMissionId) return false;
    const mission = readJsonSafe(statePath(item.linkedMissionId), null);
    if (!mission) {
      item.status = 'failed';
      item.error = 'linked mission state missing';
      item.finishedAt = Date.now();
      batch.status = 'paused';
      batch.pauseReason = item.error;
      batch.activeItemId = null;
      return true;
    }

    item.linkedMissionStatus = mission.status;
    item.actualTouchedFiles = mission.actualTouchedFiles || item.actualTouchedFiles || [];
    if (mission.status === 'done') {
      item.status = 'done';
      item.finishedAt = mission.finishedAt || Date.now();
      batch.activeItemId = null;
      return true;
    }
    if (['paused_for_human', 'error', 'failed'].includes(mission.status)) {
      item.status = mission.status === 'error' ? 'failed' : 'paused';
      item.error = mission.error || `mission ${mission.status}`;
      item.finishedAt = Date.now();
      batch.status = 'paused';
      batch.pauseReason = item.error;
      batch.activeItemId = item.id;
      return true;
    }
    return false;
  }

  function scheduleBatchRunner() {
    if (batchRunnerScheduled) return;
    batchRunnerScheduled = true;
    setImmediate(runBatchQueue);
  }

  function runBatchQueue() {
    batchRunnerScheduled = false;
    const batches = listBatches().sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));

    for (const batch of batches) {
      if (!['queued', 'running'].includes(batch.status)) continue;

      let changed = refreshRunningBatchItem(batch);
      if (batch.status === 'paused') {
        if (changed) {
          saveBatch(batch);
          emitBatch(batchSummary(batch));
        }
        continue;
      }

      const running = (batch.items || []).find((item) => item.status === 'running');
      if (running) {
        if (changed) {
          saveBatch(batch);
          emitBatch(batchSummary(batch));
        }
        continue;
      }

      const next = (batch.items || []).find((item) => item.status === 'queued');
      if (!next) {
        batch.status = 'done';
        batch.activeItemId = null;
        batch.finishedAt = Date.now();
        saveBatch(batch);
        emitBatch(batchSummary(batch));
        continue;
      }

      const busy = findBusyMission(batch.targetProject);
      if (busy) {
        batch.status = 'running';
        batch.waitingForMissionId = busy.id;
        batch.waitingSince = batch.waitingSince || Date.now();
        saveBatch(batch);
        emitBatch(batchSummary(batch));
        continue;
      }

      const mission = readJsonSafe(statePath(next.linkedMissionId), null);
      if (!mission) {
        next.status = 'failed';
        next.error = 'linked mission state missing';
        batch.status = 'paused';
        batch.pauseReason = next.error;
        saveBatch(batch);
        emitBatch(batchSummary(batch));
        continue;
      }
      if (mission.status === 'done') {
        next.status = 'done';
        next.finishedAt = mission.finishedAt || Date.now();
        next.actualTouchedFiles = mission.actualTouchedFiles || [];
        next.linkedMissionStatus = mission.status;
        saveBatch(batch);
        emitBatch(batchSummary(batch));
        scheduleBatchRunner();
        continue;
      }

      batch.status = 'running';
      batch.waitingForMissionId = null;
      batch.waitingSince = null;
      batch.activeItemId = next.id;
      next.status = 'running';
      next.startedAt = Date.now();
      next.linkedMissionStatus = 'queued';
      saveBatch(batch);
      emitBatch(batchSummary(batch));

      const start = startMissionNow(io, mission, 'coding', () => scheduleBatchRunner());
      if (!start.started) {
        next.status = 'queued';
        next.startedAt = null;
        batch.activeItemId = null;
        batch.waitingForMissionId = start.busyMissionId;
        batch.waitingSince = Date.now();
        saveBatch(batch);
        emitBatch(batchSummary(batch));
      }
    }
  }

  setImmediate(scheduleBatchRunner);

  router.get('/api/handoffs', (req, res) => {
    res.json({ dir: HANDOFFS_DIR, files: listHandoffs() });
  });

  router.get('/api/guidelines', (req, res) => {
    res.json({ dir: GUIDELINES_DIR, files: listGuidelines() });
  });

  router.get('/api/models', (req, res) => {
    res.json({ models: Object.keys(CLI_REGISTRY) });
  });

  router.get('/api/agents/catalog', (req, res) => {
    res.json({ agents: ROLE_CATALOG });
  });

  router.post('/api/batches/analyze', async (req, res) => {
    const body = req.body || {};
    const targetProject = body.target_project || DEFAULT_PROJECT;
    try {
      const analysis = await analyzeBatch({
        planPaths: body.plan_paths,
        handoffsDir: HANDOFFS_DIR,
        targetProject,
        plannerModel: body.planner_model || 'gpt-5.5',
        useAi: body.use_ai,
      });
      res.json({
        ok: true,
        analysis,
        dirtyStatus: dirtyProjectStatus(targetProject),
      });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.post('/api/batches', async (req, res) => {
    const body = req.body || {};
    const targetProject = body.target_project || DEFAULT_PROJECT;
    let analysis = body.analysis;

    try {
      if (!analysis || !Array.isArray(analysis.items)) {
        analysis = await analyzeBatch({
          planPaths: body.plan_paths,
          handoffsDir: HANDOFFS_DIR,
          targetProject,
          plannerModel: body.planner_model || 'gpt-5.5',
          useAi: body.use_ai,
        });
      }

      const sourceItems = (analysis.items || [])
        .slice()
        .sort((a, b) => Number(a.order || 0) - Number(b.order || 0));
      if (sourceItems.length === 0) throw new Error('batch requires at least one plan');
      for (const item of sourceItems) assertPlanPath(item.planPath);

      const batchId = newBatchId();
      const batch = {
        id: batchId,
        status: 'queued',
        targetProject,
        planner: analysis.planner || 'unknown',
        note: analysis.note || '',
        dirtyStatus: dirtyProjectStatus(targetProject),
        activeItemId: null,
        waitingForMissionId: null,
        waitingSince: null,
        pauseReason: null,
        collisions: analysis.collisions || [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
        items: [],
      };

      const models = body.models || {};
      const autoOrchestrate = body.auto_orchestrate !== false;
      const smartRoute = body.smart_route !== false;
      const warningPolicy = body.warning_policy || process.env.MISSION_WARNING_POLICY || 'strict';

      sourceItems.forEach((item, idx) => {
        const batchItemId = `item_${idx + 1}_${crypto.randomBytes(2).toString('hex')}`;
        const mission = createMissionFromPlan({
          plan_path: item.planPath,
          target_project: targetProject,
          title: item.title,
          models,
          auto_orchestrate: autoOrchestrate,
          smart_route: smartRoute,
          warning_policy: warningPolicy,
          batchId,
          batchItemId,
        });
        batch.items.push({
          id: batchItemId,
          order: idx + 1,
          planPath: item.planPath,
          fileName: item.fileName || path.basename(item.planPath),
          title: item.title || mission.title,
          predictedFiles: item.predictedFiles || [],
          actualTouchedFiles: [],
          dependencies: item.dependencies || [],
          reason: item.reason || '',
          collisionGroup: item.collisionGroup || null,
          linkedMissionId: mission.id,
          linkedMissionStatus: mission.status,
          status: 'queued',
          startedAt: null,
          finishedAt: null,
          error: null,
        });
      });

      saveBatch(batch);
      res.json({ ok: true, id: batch.id, batch: batchSummary(batch) });
      scheduleBatchRunner();
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.get('/api/batches', (req, res) => {
    scheduleBatchRunner();
    res.json({ batches: listBatches().map(batchSummary) });
  });

  router.get('/api/batches/:id', (req, res) => {
    const batch = getBatch(req.params.id);
    if (!batch) return res.status(404).json({ error: 'not found' });
    refreshRunningBatchItem(batch);
    saveBatch(batch);
    res.json(batchSummary(batch));
  });

  router.post('/api/batches/:id/pause', (req, res) => {
    const batch = getBatch(req.params.id);
    if (!batch) return res.status(404).json({ error: 'not found' });
    if (!['done', 'failed'].includes(batch.status)) {
      batch.status = 'paused';
      batch.pausedAt = Date.now();
      batch.pauseReason = 'paused by user';
      saveBatch(batch);
      emitBatch(batchSummary(batch));
    }
    res.json({ ok: true, batch: batchSummary(batch) });
  });

  router.post('/api/batches/:id/resume', (req, res) => {
    const batch = getBatch(req.params.id);
    if (!batch) return res.status(404).json({ error: 'not found' });
    if (batch.status === 'done') return res.status(409).json({ error: 'batch already done' });
    const blockedItem = (batch.items || []).find((item) => (
      ['paused', 'failed'].includes(item.status) && item.linkedMissionId
    ));
    if (blockedItem) {
      blockedItem.status = 'queued';
      blockedItem.error = null;
    }
    batch.status = (batch.items || []).some((item) => item.status === 'running') ? 'running' : 'queued';
    batch.pauseReason = null;
    batch.pausedAt = null;
    saveBatch(batch);
    emitBatch(batchSummary(batch));
    scheduleBatchRunner();
    res.json({ ok: true, batch: batchSummary(batch) });
  });

  router.get('/api/missions', (req, res) => {
    res.json({ missions: listMissions() });
  });

  router.get('/api/missions/:id', (req, res) => {
    const st = readJsonSafe(statePath(req.params.id), null);
    if (!st) return res.status(404).json({ error: 'not found' });
    res.json(st);
  });

  router.get('/api/missions/:id/transcript/:phase', (req, res) => {
    const tPath = transcriptPath(req.params.id, req.params.phase);
    if (!fs.existsSync(tPath)) return res.status(404).json({ error: 'no transcript' });
    res.type('text/plain').send(fs.readFileSync(tPath, 'utf8'));
  });

  router.get('/api/missions/:id/artifacts', (req, res) => {
    const all = collectArtifacts(req.params.id);
    res.json({ artifacts: all.map((a) => ({ path: a.path, size: a.content.length })) });
  });

  router.get('/api/missions/:id/findings', (req, res) => {
    // For v3 missions, return latest sub-phase findings; for v2 use review phase findings
    const mission = readJsonSafe(statePath(req.params.id), null);
    if (!mission) return res.status(404).json({ error: 'no mission' });

    if (mission.autoOrchestrate && mission.subPhases && mission.subPhases.length > 0) {
      // Latest sub-phase, latest iteration findings
      const sp = mission.subPhases.slice().reverse().find((s) => s.iterations.length > 0);
      if (sp) {
        const iter = sp.iterations[sp.iterations.length - 1];
        const p = path.join(missionDir(req.params.id), `sub-${sp.id}`, `iteration-${iter.idx}`, 'review', 'artifacts', 'findings.md');
        if (fs.existsSync(p)) return res.type('text/plain').send(fs.readFileSync(p, 'utf8'));
      }
      return res.status(404).json({ error: 'no findings yet in v3 mission' });
    }
    const p = path.join(artifactsDir(req.params.id, 'review'), 'findings.md');
    if (!fs.existsSync(p)) return res.status(404).json({ error: 'no findings yet' });
    res.type('text/plain').send(fs.readFileSync(p, 'utf8'));
  });

  router.get('/api/missions/:id/summary', (req, res) => {
    const p = path.join(missionDir(req.params.id), 'final-summary.md');
    if (!fs.existsSync(p)) return res.status(404).json({ error: 'final summary not yet generated' });
    res.type('text/plain').send(fs.readFileSync(p, 'utf8'));
  });

  router.post('/api/missions', async (req, res) => {
    const body = req.body || {};
    if (!body.plan_path) return res.status(400).json({ error: 'plan_path required' });
    const targetProj = body.target_project || DEFAULT_PROJECT;
    const startImmediately = body.start_immediately !== false && body.queued_only !== true;
    if (startImmediately) {
      const busy = findBusyMission(targetProj);
      if (busy) {
        return res.status(409).json({
          error: `target_project busy: mission ${busy.id} is already running`,
          busyMissionId: busy.id,
        });
      }
    }

    let mission;
    try {
      mission = createMissionFromPlan(body);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }

    res.json({ ok: true, id: mission.id, mission, started: startImmediately });
    if (startImmediately) {
      const started = startMissionNow(io, mission, 'coding');
      if (!started.started) {
        console.warn('[mission] created but queued because project lock was busy:', mission.id, started.busyMissionId);
      }
    }
  });

  router.post('/api/missions/:id/rerun', async (req, res) => {
    const { from_phase } = req.body || {};
    const phase = from_phase || 'coding';
    if (!PHASE_ORDER.includes(phase)) return res.status(400).json({ error: 'bad phase' });
    const mission = readJsonSafe(statePath(req.params.id), null);
    if (!mission) return res.status(404).json({ error: 'not found' });
    if (isActiveMissionStatus(mission.status)) return res.status(409).json({ error: 'already running' });
    const busy = findBusyMission(mission.targetProject, mission.id);
    if (busy) return res.status(409).json({ error: `target_project busy: mission ${busy.id} is already running`, busyMissionId: busy.id });
    mission.status = 'queued';
    mission.error = null;
    writeJson(statePath(mission.id), mission);
    res.json({ ok: true, from: phase });
    startMissionJobNow(mission, () => runPipeline(io, mission, phase));
  });

  router.post('/api/missions/:id/resume', async (req, res) => {
    const mission = readJsonSafe(statePath(req.params.id), null);
    if (!mission) return res.status(404).json({ error: 'not found' });
    if (!mission.autoOrchestrate) return res.status(400).json({ error: 'resume is only available for auto-orchestrated missions' });
    if (['preflight', 'planning', 'executing', 'summarizing', 'running'].includes(mission.status)) {
      return res.status(409).json({ error: `mission is already ${mission.status}` });
    }
    const busy = findBusyMission(mission.targetProject, mission.id);
    if (busy) return res.status(409).json({ error: `target_project busy: mission ${busy.id} is already running`, busyMissionId: busy.id });

    const checkpoint = findResumeCheckpoint(mission);
    mission.status = 'queued';
    mission.error = null;
    mission.resumeCheckpoint = checkpoint;
    writeJson(statePath(mission.id), mission);

    res.json({ ok: true, checkpoint });
    const saveState = () => { mission.updatedAt = Date.now(); writeJson(statePath(mission.id), mission); };
    startMissionJobNow(mission, () => resumeAutoOrchestrator({
      io, mission,
      missionDir: missionDir(mission.id),
      sysPrompts: SYS_PROMPTS,
      listGuidelines,
      saveState,
    }));
  });

  router.delete('/api/missions/:id', (req, res) => {
    const dir = missionDir(req.params.id);
    if (!fs.existsSync(dir)) return res.status(404).json({ error: 'not found' });
    fs.rmSync(dir, { recursive: true, force: true });
    unregisterMissionDir(req.params.id);
    res.json({ ok: true });
  });

  return router;
};
