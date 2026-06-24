// Mission v3 — Auto-Orchestrator
//   Planner → for each sub-phase (Coding → Review → maybe Fix iter → Refill) → Final Summary
// Designed for one-click long plans where the agent decomposes scope itself.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { runAgent, parseFileBlocks } = require('./mission-agents');
const {
  compactAgentBriefForStage,
  promptActiveRoleKeysForStage,
} = require('./mission-intelligence');
const {
  buildMarker,
  newRunId,
  recordMissionSessionMapping,
  withMissionMarker,
} = require('./mission-session-map');
const {
  diffProjectSnapshots,
  mergeTouchedFiles,
  snapshotProject,
} = require('./project-snapshot');
const telegram = require('./telegram');

const MAX_FIX_ITERATIONS = Number(process.env.MISSION_MAX_FIX_ITER || 2);

function ensureDir(d) { try { fs.mkdirSync(d, { recursive: true }); } catch {} }
function writeJson(p, o) { fs.writeFileSync(p, JSON.stringify(o, null, 2)); }
function appendLine(p, line) { try { fs.appendFileSync(p, line + '\n'); } catch {} }

function safeExec(cmd) {
  try { return execSync(cmd, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }).trim(); } catch { return ''; }
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
  if (mission.fileChanges.length > 200) {
    mission.fileChanges = mission.fileChanges.slice(-200);
  }
  mission.actualTouchedFiles = mergeTouchedFiles(mission.actualTouchedFiles, entry.changes);
}

function gatherChanges(proj, base) {
  if (!proj || !base) return null;
  return {
    log: safeExec(`git -C "${proj}" log --oneline ${base}..HEAD 2>/dev/null`),
    namesAdded: safeExec(`git -C "${proj}" diff --name-only ${base}..HEAD 2>/dev/null`),
    diffStat: safeExec(`git -C "${proj}" diff --stat ${base}..HEAD 2>/dev/null`),
    status: safeExec(`git -C "${proj}" status --short 2>/dev/null`),
    headSha: safeExec(`git -C "${proj}" rev-parse HEAD 2>/dev/null`),
  };
}

function extractVerdict(findingsContent) {
  if (!findingsContent) return 'FAIL';
  const m = findingsContent.match(/\*\*Verdict\*\*\s*:?\s*[`']?(PASS|WARN|FAIL)[`']?/i);
  return m ? m[1].toUpperCase() : 'FAIL';
}

function extractSubPhases(plannerOutput) {
  const m = plannerOutput.match(/```subphases\s*\n([\s\S]*?)\n```/);
  if (!m) return null;
  try {
    return JSON.parse(m[1].trim());
  } catch (e) {
    return { _parseError: e.message, _raw: m[1] };
  }
}

function isRunningStatus(status) {
  return ['preflight', 'planning', 'executing', 'summarizing'].includes(status);
}

function checkpointLabel(mission, checkpoint) {
  if (!checkpoint) return 'next pending step';
  const subPhase = (mission.subPhases || []).find((sp, idx) => (
    sp.id === checkpoint.subPhaseId || idx === checkpoint.subPhaseIdx
  ));
  const bits = [];
  if (subPhase) bits.push(`Sub-phase ${subPhase.id}`);
  if (checkpoint.iteration !== undefined) bits.push(`iteration ${checkpoint.iteration}`);
  if (checkpoint.phase) bits.push(checkpoint.phase);
  return bits.join(' · ') || checkpoint.phase || 'next pending step';
}

function getLatestFindingsPath(missionDir, subPhase, iterIdx) {
  return path.join(missionDir, `sub-${subPhase.id}`, `iteration-${iterIdx}`, 'review', 'artifacts', 'findings.md');
}

function getIterationFindingsPath(missionDir, subPhase, iterIdx, dirName = 'review') {
  return path.join(missionDir, `sub-${subPhase.id}`, `iteration-${iterIdx}`, dirName, 'artifacts', 'findings.md');
}

function readIterationVerdict(missionDir, subPhase, iterIdx, dirName = 'review') {
  let findings = '';
  try { findings = fs.readFileSync(getIterationFindingsPath(missionDir, subPhase, iterIdx, dirName), 'utf8'); } catch {}
  return extractVerdict(findings);
}

function getCodingFallbackModel(mission) {
  return (mission.models && mission.models.codingFallback) || process.env.SWARM_DEFAULT_GLM_MODEL || 'glm-4.5';
}

function selectInnerPhaseModel(mission, phase, iter) {
  if (phase === 'coding' && iter && iter.idx > 0) return getCodingFallbackModel(mission);
  return (mission.models && mission.models[phase]) || (phase === 'coding' ? 'gpt-5.5' : 'opus');
}

function safeModelName(model) {
  return String(model || 'model').replace(/[^a-z0-9_.-]+/gi, '-').slice(0, 80) || 'model';
}

function tailText(text, maxChars = 4000) {
  const value = String(text || '');
  if (value.length <= maxChars) return value;
  return value.slice(value.length - maxChars);
}

function copyIfExists(from, to) {
  try {
    if (fs.existsSync(from)) fs.copyFileSync(from, to);
  } catch {}
}

function readTextIfExists(filePath, maxChars = null) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return '';
    const text = fs.readFileSync(filePath, 'utf8');
    if (!maxChars || text.length <= maxChars) return text;
    return text.slice(0, maxChars) + '\n\n...[context map truncated]';
  } catch {
    return '';
  }
}

function contextMapMdPath(missionDir) {
  return path.join(missionDir, 'context-map.md');
}

function contextMapJsonPath(missionDir) {
  return path.join(missionDir, 'context-map.json');
}

function contextMapSection(missionDir, maxChars, mode = 'excerpt') {
  const mdPath = contextMapMdPath(missionDir);
  const content = readTextIfExists(mdPath, maxChars);
  if (!content) return '';
  const label = mode === 'full' ? 'Context Scout Preflight Map' : 'Context Scout Preflight Map Excerpt';
  return [
    `# ${label}`,
    '',
    `Source: ${mdPath}`,
    `JSON: ${contextMapJsonPath(missionDir)}`,
    '',
    content,
    '',
  ].join('\n');
}

function subPhaseStageText(subPhase) {
  if (!subPhase) return '';
  return [
    subPhase.id,
    subPhase.title,
    subPhase.summary,
    subPhase.scope_md,
  ].filter(Boolean).join('\n\n');
}

function setPromptActiveRoles(mission, stage, stageText, saveState) {
  const roster = mission.intelligence && mission.intelligence.roster;
  const keys = promptActiveRoleKeysForStage(roster, stage, stageText);
  mission.promptActiveRoleKeys = keys;
  if (saveState) saveState();
  return keys;
}

function findResumeCheckpoint(mission) {
  if (mission.resumeCheckpoint && mission.resumeCheckpoint.phase) return mission.resumeCheckpoint;
  if (!mission.contextScout || !mission.contextScout.pathMd) return { stage: 'preflight' };

  const subPhases = mission.subPhases || [];
  if (!subPhases.length) return { stage: 'planner' };

  let subPhaseIdx = Number.isInteger(mission.currentSubPhaseIdx) ? mission.currentSubPhaseIdx : -1;
  if (subPhaseIdx < 0) {
    subPhaseIdx = subPhases.findIndex((sp) => ['running', 'paused'].includes(sp.status));
  }
  if (subPhaseIdx < 0) {
    subPhaseIdx = subPhases.findIndex((sp) => !['pass', 'warn'].includes(sp.status));
  }
  if (subPhaseIdx < 0) return { stage: 'summary' };

  const subPhase = subPhases[subPhaseIdx];
  let iter = subPhase.iterations && subPhase.iterations[subPhase.iterations.length - 1];
  if (!iter) {
    return { subPhaseIdx, subPhaseId: subPhase.id, iteration: 0, phase: 'coding' };
  }

  if (!iter.phases || !iter.phases.coding || iter.phases.coding.exitCode !== 0) {
    return { subPhaseIdx, subPhaseId: subPhase.id, iteration: iter.idx || 0, phase: 'coding' };
  }
  if (!iter.phases.review || iter.phases.review.exitCode !== 0) {
    return { subPhaseIdx, subPhaseId: subPhase.id, iteration: iter.idx || 0, phase: 'review' };
  }
  if ((iter.verdict === 'PASS' || iter.verdict === 'WARN') && (!iter.phases.refill || iter.phases.refill.exitCode !== 0)) {
    return { subPhaseIdx, subPhaseId: subPhase.id, iteration: iter.idx || 0, phase: 'refill' };
  }
  if (iter.verdict === 'WARN' && mission.warningPolicy !== 'soft' && (!iter.phases.reviewAfterRefill || iter.phases.reviewAfterRefill.exitCode !== 0)) {
    return { subPhaseIdx, subPhaseId: subPhase.id, iteration: iter.idx || 0, phase: 'review' };
  }
  if (iter.verdict === 'FAIL') {
    return { subPhaseIdx, subPhaseId: subPhase.id, iteration: (iter.idx || 0) + 1, phase: 'coding' };
  }
  return { subPhaseIdx, subPhaseId: subPhase.id, iteration: iter.idx || 0, phase: 'review' };
}

// Run an agent with line streaming + progress poller. Returns result.
async function runAgentWithObserver(opts) {
  const { io, room, mission, phaseLabel, prompt, model, transcriptPath, progressContext, workspaceKind, saveState } = opts;
  // workdir = where the agent runs + where we snapshot/diff. Defaults to the
  // shared target project (sequential path); parallel path passes a worktree dir.
  const workdir = opts.workdir || mission.targetProject;
  const baseCommit = opts.baseCommit || mission.startCommit;
  const kind = workspaceKind || phaseLabel;
  const runId = newRunId();
  const marker = buildMarker(mission, kind, runId);
  const promptWithMarker = withMissionMarker(prompt, marker, mission, kind);
  ensureDir(path.dirname(transcriptPath));
  fs.writeFileSync(transcriptPath, `# Phase: ${phaseLabel}\n# Kind: ${kind}\n# Model: ${model}\n# Marker: ${marker}\n# Started: ${new Date().toISOString()}\n\n`);

  const start = Date.now();
  const beforeSnapshot = snapshotProject(workdir);
  io.to(room).emit('mission:phase-start', { id: mission.id, phase: phaseLabel, model, ...progressContext });

  // Progress poller (every 5s)
  let lastSig = '';
  const poller = setInterval(() => {
    try {
      const proj = workdir;
      const base = baseCommit;
      const commits = base ? safeExec(`git -C "${proj}" log --oneline ${base}..HEAD 2>/dev/null`) : '';
      const status = safeExec(`git -C "${proj}" status --short 2>/dev/null`);
      const recentList = safeExec(
        `find "${proj}" -type f -mmin -1 ` +
        `! -path '*/node_modules/*' ! -path '*/.git/*' ! -path '*/.next/*' ` +
        `! -path '*/__pycache__/*' ! -path '*/.tmp/*' ` +
        `-printf '%TT %p\\n' 2>/dev/null | sort -r | head -10 | awk '{print $2}'`
      );
      const cpuInfo = safeExec(`ps -C claude -o pid=,etime=,time=,pcpu=,pmem= 2>/dev/null | head -3`);
      const commitCount = commits ? commits.split('\n').filter(Boolean).length : 0;
      const modCount = status ? status.split('\n').filter(Boolean).length : 0;
      const recentFiles = recentList ? recentList.split('\n').filter(Boolean).map((p) => p.replace(proj + '/', '')) : [];
      const sig = `${commitCount}:${modCount}:${recentFiles.join(',')}`;
      const changed = sig !== lastSig;
      lastSig = sig;
      io.to(room).emit('mission:progress', {
        id: mission.id, phase: phaseLabel,
        elapsedMs: Date.now() - start,
        commitsMade: commitCount,
        latestCommit: commits.split('\n')[0] || null,
        workingTreeModified: modCount,
        recentFiles, cpuInfo, changed,
        ts: Date.now(),
        ...progressContext,
      });
    } catch {}
  }, 5000);

  let result;
  let fileChangeEntry = null;
  try {
    result = await runAgent({
      model,
      prompt: promptWithMarker,
      cwd: workdir,
      onLine: (line) => {
        appendLine(transcriptPath, line);
        io.to(room).emit('mission:line', { id: mission.id, phase: phaseLabel, line, ...progressContext });
      },
      onErr: (chunk) => {
        appendLine(transcriptPath, '[stderr] ' + chunk.trimEnd());
        io.to(room).emit('mission:err', { id: mission.id, phase: phaseLabel, chunk, ...progressContext });
      },
    });
  } finally {
    clearInterval(poller);
    const afterSnapshot = snapshotProject(workdir);
    const changes = diffProjectSnapshots(beforeSnapshot, afterSnapshot);
    fileChangeEntry = {
      phase: phaseLabel,
      workspaceKind: kind,
      subPhaseId: progressContext && progressContext.subPhaseId,
      iteration: progressContext && progressContext.iteration,
      stage: progressContext && progressContext.stage,
      startedAt: start,
      finishedAt: Date.now(),
      before: compactSnapshotMeta(beforeSnapshot),
      after: compactSnapshotMeta(afterSnapshot),
      changes,
    };
    recordMissionFileChanges(mission, fileChangeEntry);
    if (saveState) saveState();
    io.to(room).emit('mission:file-changes', {
      id: mission.id,
      phase: phaseLabel,
      changes,
      ...progressContext,
    });
  }

  fs.appendFileSync(transcriptPath, `\n\n# Completed: ${new Date().toISOString()}\n# Exit: ${result.exitCode}\n# Duration: ${result.durationMs}ms\n`);
  const mapping = recordMissionSessionMapping({ mission, kind, model, marker, startedAt: start, logPath: transcriptPath });
  if (mapping.ok) {
    fs.appendFileSync(transcriptPath, `# Session mapping: ${mapping.sessionIds.join(', ')}\n`);
  }
  io.to(room).emit('mission:phase-end', {
    id: mission.id, phase: phaseLabel,
    durationMs: result.durationMs, exitCode: result.exitCode,
    fileChanges: fileChangeEntry ? fileChangeEntry.changes : null,
    ...progressContext,
  });
  result.fileChangeEntry = fileChangeEntry;
  return result;
}

// ─── Context Scout preflight ───────────────────────────────────────
function validateContextMapJson(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Context Scout produced invalid context-map.json: ${err.message}`);
  }
  const required = ['summary', 'likely_files', 'tests', 'constraints', 'risks', 'do_not_read', 'context_budget'];
  const missing = required.filter((key) => parsed[key] === undefined);
  if (missing.length) {
    throw new Error(`Context Scout context-map.json missing keys: ${missing.join(', ')}`);
  }
  return parsed;
}

async function runContextScout(ctx) {
  const { io, mission, missionDir, sysPrompts, saveState } = ctx;
  const room = `mission-${mission.id}`;
  const plan = fs.readFileSync(path.join(missionDir, 'plan.md'), 'utf8');
  const stageText = plan;
  const promptRoleKeys = setPromptActiveRoles(mission, 'preflight', stageText, saveState);
  const model = (mission.models && (mission.models.contextScout || mission.models.planner)) || 'gpt-5.5';

  mission.status = 'preflight';
  mission.resumeCheckpoint = { stage: 'preflight', model, updatedAt: Date.now() };
  saveState();
  io.to(room).emit('mission:preflight-start', { id: mission.id, model, promptRoleKeys });

  let prompt = sysPrompts.contextScout.trim();
  const brief = compactAgentBriefForStage(
    mission.intelligence && mission.intelligence.roster,
    'preflight',
    stageText,
  );
  if (brief) prompt += '\n\n---\n\n' + brief;
  prompt += '\n\n---\n\n# Original Plan\n\n' + plan;
  prompt += `\n\n---\n\nProject root (cwd): ${mission.targetProject}\n`;
  prompt += '\nYou must emit file blocks only; do not write files into the target project.\n';

  const result = await runAgentWithObserver({
    io, room, mission,
    phaseLabel: 'preflight',
    model,
    prompt,
    transcriptPath: path.join(missionDir, 'preflight', 'transcript.log'),
    progressContext: { stage: 'preflight', promptRoleKeys },
    workspaceKind: 'preflight',
    saveState,
  });
  fs.writeFileSync(path.join(missionDir, 'preflight', 'raw-output.txt'), result.stdout);
  if (result.exitCode !== 0) {
    throw new Error(`Context Scout exited with code ${result.exitCode}`);
  }

  const touched = result.fileChangeEntry && result.fileChangeEntry.changes && result.fileChangeEntry.changes.counts
    ? result.fileChangeEntry.changes.counts.touched
    : 0;
  if (touched > 0) {
    throw new Error(`Context Scout must be read-only but touched ${touched} target project file(s)`);
  }

  const blocks = parseFileBlocks(result.stdout);
  const byPath = new Map(blocks.map((block) => [block.path, block.content]));
  const jsonContent = byPath.get('context-map.json');
  const mdContent = byPath.get('context-map.md');
  if (!jsonContent || !mdContent) {
    throw new Error('Context Scout must emit both context-map.json and context-map.md file blocks');
  }
  validateContextMapJson(jsonContent);

  const jsonPath = contextMapJsonPath(missionDir);
  const mdPath = contextMapMdPath(missionDir);
  fs.writeFileSync(jsonPath, jsonContent);
  fs.writeFileSync(mdPath, mdContent);
  mission.contextScout = {
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    pathMd: mdPath,
    pathJson: jsonPath,
    model,
    completedAt: Date.now(),
  };
  mission.resumeCheckpoint = { stage: 'planner', updatedAt: Date.now() };
  saveState();
  io.to(room).emit('mission:preflight-end', {
    id: mission.id,
    durationMs: result.durationMs,
    pathMd: mdPath,
    pathJson: jsonPath,
    promptRoleKeys,
  });
  return mission.contextScout;
}

// ─── Planner phase ────────────────────────────────────────────────
async function runPlanner(ctx) {
  const { io, mission, missionDir, sysPrompts, saveState } = ctx;
  const room = `mission-${mission.id}`;
  const plan = fs.readFileSync(path.join(missionDir, 'plan.md'), 'utf8');
  const promptRoleKeys = setPromptActiveRoles(mission, 'planner', plan, saveState);
  mission.resumeCheckpoint = { stage: 'planner', model: mission.models.planner || 'opus', updatedAt: Date.now() };
  saveState();

  let prompt = sysPrompts.planner.trim();
  if (mission.intelligence && mission.intelligence.roster) {
    const brief = compactAgentBriefForStage(mission.intelligence.roster, 'planner', plan);
    if (brief) prompt += '\n\n---\n\n' + brief;
    prompt += '\n# Mission Intelligence\n\n';
    prompt += `Complexity: ${mission.intelligence.complexity.score}/100 (${mission.intelligence.complexity.band})\n`;
    prompt += `Routing strategy: ${mission.intelligence.route.strategy}\n`;
    prompt += `Models: ${JSON.stringify(mission.models)}\n`;
    prompt += `Warning policy: ${mission.warningPolicy || 'strict'}\n`;
  }
  const contextMap = contextMapSection(missionDir, 12000, 'full');
  if (contextMap) prompt += '\n\n---\n\n' + contextMap;
  prompt += '\n\n---\n\n# Plan (full)\n\n' + plan;
  prompt += `\n\n---\n\nProject root (for est context): ${mission.targetProject}\n`;

  const result = await runAgentWithObserver({
    io, room, mission,
    phaseLabel: 'planner',
    model: mission.models.planner || 'opus',
    prompt,
    transcriptPath: path.join(missionDir, 'planner', 'transcript.log'),
    progressContext: { stage: 'planner', promptRoleKeys },
    workspaceKind: 'summary',
    saveState,
  });
  fs.writeFileSync(path.join(missionDir, 'planner', 'raw-output.txt'), result.stdout);

  const parsed = extractSubPhases(result.stdout);
  if (!parsed || parsed._parseError || !Array.isArray(parsed.phases)) {
    throw new Error('Planner output unusable: ' + (parsed && parsed._parseError ? parsed._parseError : 'no `subphases` JSON block found'));
  }
  fs.writeFileSync(path.join(missionDir, 'phases.json'), JSON.stringify(parsed, null, 2));
  mission.subPhases = parsed.phases.map((p, idx) => ({
    idx,
    id: p.id || `p${idx + 1}`,
    title: p.title,
    summary: p.summary,
    scope_md: p.scope_md,
    dependencies: p.dependencies || [],
    estFiles: p.est_files_touched || null,
    iterations: [],
    status: 'queued',
    finalVerdict: null,
    finalCommit: null,
  }));
  mission.plannerNotes = parsed.notes || '';
  mission.planner = { exitCode: result.exitCode, durationMs: result.durationMs };
  return mission.subPhases;
}

// ─── Run one phase (coding/refill/review) inside a sub-phase iteration ─
async function runInnerPhase(ctx, subPhase, iter, phase, opts = {}) {
  const { io, mission, missionDir, sysPrompts, listGuidelines, saveState } = ctx;
  const room = `mission-${mission.id}`;
  // Sequential path: workdir = shared target project (unchanged).
  // Parallel path: workdir = this sub-phase's isolated git worktree.
  const workdir = opts.workdir || mission.targetProject;
  const baseCommit = opts.baseCommit || mission.startCommit;
  const iterDir = path.join(missionDir, `sub-${subPhase.id}`, `iteration-${iter.idx}`);
  const dirName = opts.dirName || phase;
  const phaseLabel = opts.phaseLabel || phase;
  const phaseDir = path.join(iterDir, dirName);
  fs.rmSync(phaseDir, { recursive: true, force: true });
  ensureDir(phaseDir);
  ensureDir(path.join(phaseDir, 'artifacts'));
  const stageForRoles = (phase === 'coding' && iter.idx > 0) ? 'fix' : phaseLabel;
  const stageText = subPhaseStageText(subPhase);
  const promptRoleKeys = setPromptActiveRoles(mission, stageForRoles, stageText, saveState);

  // Build prompt
  const systemPrompt = (phase === 'coding' && iter.idx > 0)
    ? sysPrompts.fixIteration   // iteration 1+ uses fix prompt
    : sysPrompts[phase];

  let prompt = systemPrompt.trim();
  if (mission.intelligence && mission.intelligence.roster) {
    const brief = compactAgentBriefForStage(mission.intelligence.roster, stageForRoles, stageText);
    if (brief) prompt += '\n\n---\n\n' + brief;
    prompt += '\n# Mission Intelligence\n\n';
    prompt += `Complexity: ${mission.intelligence.complexity.score}/100 (${mission.intelligence.complexity.band})\n`;
    prompt += `Routing strategy: ${mission.intelligence.route.strategy}\n`;
    prompt += `Current phase: ${phaseLabel}\n`;
    prompt += `Warning policy: ${mission.warningPolicy || 'strict'}\n`;
  }
  prompt += '\n\n---\n\n# Sub-phase scope\n\n';
  prompt += `**Sub-phase ${subPhase.id}: ${subPhase.title}**\n\n`;
  prompt += `${subPhase.summary}\n\n`;
  prompt += subPhase.scope_md;
  prompt += `\n\n---\n\nProject root (cwd): ${workdir}\n\n`;
  const contextMap = contextMapSection(missionDir, 4000, 'excerpt');
  if (contextMap) {
    prompt += contextMap;
    prompt += 'Use the context map as a lightweight index. Read only the specific source files needed for this sub-phase.\n\n';
  }

  // For non-coding phases (or iter > 0): inject git diff context
  if (phase !== 'coding' || iter.idx > 0) {
    const baseSha = (iter.idx > 0 && iter.idx > 0 && iter.startCommit) ? iter.startCommit : baseCommit;
    const changes = gatherChanges(workdir, baseSha);
    if (changes && (changes.namesAdded || changes.status)) {
      prompt += '# Changes in target project (via git)\n\n';
      prompt += `Baseline commit: ${baseSha || '(unknown)'}\n`;
      prompt += `Current HEAD: ${changes.headSha || '(unknown)'}\n\n`;
      if (changes.log) prompt += `## Commits so far\n\`\`\`\n${changes.log}\n\`\`\`\n\n`;
      if (changes.namesAdded) prompt += `## Files modified\n\`\`\`\n${changes.namesAdded}\n\`\`\`\n\n`;
      if (changes.diffStat) prompt += `## Diff stat\n\`\`\`\n${changes.diffStat}\n\`\`\`\n\n`;
      if (changes.status) prompt += `## Uncommitted\n\`\`\`\n${changes.status}\n\`\`\`\n\n`;
      prompt += `**Use Read tool freely** — cwd is set to ${workdir}.\n\n`;
    }
  }

  // For fix iterations: inject previous findings.md
  if (phase === 'coding' && iter.idx > 0) {
    const prevIter = subPhase.iterations[iter.idx - 1];
    const prevFindingsPath = prevIter && prevIter.findingsPath
      ? prevIter.findingsPath
      : path.join(missionDir, `sub-${subPhase.id}`, `iteration-${prevIter.idx}`, 'review', 'artifacts', 'findings.md');
    if (fs.existsSync(prevFindingsPath)) {
      prompt += '# Previous iteration findings (fix the unresolved issues only)\n\n';
      prompt += fs.readFileSync(prevFindingsPath, 'utf8');
      prompt += '\n\n';
    }
  }

  // Refill runs after review. It receives the latest findings so it can spend
  // tokens on known WARN/suggestion polish instead of guessing blindly.
  if (phase === 'refill') {
    const findingsPath = path.join(missionDir, `sub-${subPhase.id}`, `iteration-${iter.idx}`, 'review', 'artifacts', 'findings.md');
    if (fs.existsSync(findingsPath)) {
      prompt += '# Review findings to address during refill\n\n';
      prompt += fs.readFileSync(findingsPath, 'utf8');
      prompt += '\n\n';
    }
  }

  // Inject Global Rules for all phases
  const guidelineFiles = listGuidelines();
  if (guidelineFiles.length > 0) {
    prompt += '# Global Rules（來自 ~/guidelines/）\n\n';
    prompt += '呢度係 universal rules，跨所有 phase 都適用。請逐條 honour。\n\n';
    for (const g of guidelineFiles) {
      prompt += `===== RULE FILE: ${g.name} =====\n${fs.readFileSync(g.path, 'utf8')}\n\n`;
    }
  }

  iter.startCommit = safeExec(`git -C "${workdir}" rev-parse HEAD 2>/dev/null`) || baseCommit;
  mission.resumeCheckpoint = {
    subPhaseIdx: subPhase.idx,
    subPhaseId: subPhase.id,
    iteration: iter.idx,
    phase,
    phaseLabel,
    model: selectInnerPhaseModel(mission, phase, iter),
    updatedAt: Date.now(),
  };
  mission.status = 'executing';
  if (saveState) saveState();

  const transcriptPath = path.join(phaseDir, 'transcript.log');
  const progressContext = { subPhaseId: subPhase.id, iteration: iter.idx, stage: phaseLabel, promptRoleKeys };
  const attemptedModels = [];
  let selectedModel = selectInnerPhaseModel(mission, phase, iter);

  const runAttempt = (model, attemptPrompt, extraContext = {}) => {
    attemptedModels.push(model);
    mission.resumeCheckpoint = {
      ...mission.resumeCheckpoint,
      model,
      updatedAt: Date.now(),
    };
    if (saveState) saveState();
    return runAgentWithObserver({
      io, room, mission,
      phaseLabel,
      model,
      prompt: attemptPrompt,
      transcriptPath,
      progressContext: { ...progressContext, ...extraContext },
      workspaceKind: phase,
      workdir,
      baseCommit,
      saveState,
    });
  };

  let result;
  let attemptError = null;
  try {
    result = await runAttempt(selectedModel, prompt);
  } catch (err) {
    attemptError = err;
  }

  if (phase === 'coding') {
    const fallbackModel = getCodingFallbackModel(mission);
    const shouldFallback = fallbackModel && selectedModel !== fallbackModel && (!result || result.exitCode !== 0);
    if (shouldFallback) {
      const failedModelName = safeModelName(selectedModel);
      const failedRawPath = path.join(phaseDir, `raw-output-${failedModelName}-failed.txt`);
      const failedErrPath = path.join(phaseDir, `stderr-${failedModelName}-failed.txt`);
      fs.writeFileSync(failedRawPath, result ? (result.stdout || '') : '');
      fs.writeFileSync(failedErrPath, result ? (result.stderr || '') : (attemptError && (attemptError.stack || attemptError.message)) || '');
      copyIfExists(transcriptPath, path.join(phaseDir, `transcript-${failedModelName}-failed.log`));

      io.to(room).emit('mission:phase-fallback', {
        id: mission.id,
        phase: phaseLabel,
        fromModel: selectedModel,
        toModel: fallbackModel,
        exitCode: result ? result.exitCode : null,
        error: attemptError ? attemptError.message : null,
        ...progressContext,
      });

      const fallbackPrompt = `${prompt}\n\n---\n\n# Previous coding attempt failed\n\n` +
        `Model: ${selectedModel}\n` +
        `Exit code: ${result ? result.exitCode : '(exception)'}\n` +
        `Error: ${attemptError ? attemptError.message : '(none)'}\n\n` +
        `Continue from the current workspace state. Inspect the repository before editing and finish the same sub-phase scope.\n\n` +
        `## Previous stdout tail\n\n\`\`\`\n${tailText(result && result.stdout)}\n\`\`\`\n\n` +
        `## Previous stderr tail\n\n\`\`\`\n${tailText(result ? result.stderr : attemptError && (attemptError.stack || attemptError.message))}\n\`\`\`\n`;
      selectedModel = fallbackModel;
      attemptError = null;
      result = await runAttempt(selectedModel, fallbackPrompt, { fallbackFrom: failedModelName });
    }
  }

  if (attemptError) throw attemptError;
  fs.writeFileSync(path.join(phaseDir, 'raw-output.txt'), result.stdout);

  // Parse file: blocks into artifacts/
  const blocks = parseFileBlocks(result.stdout);
  for (const b of blocks) {
    const out = path.join(phaseDir, 'artifacts', b.path);
    ensureDir(path.dirname(out));
    fs.writeFileSync(out, b.content);
  }

  if (result.exitCode !== 0) {
    throw new Error(`${checkpointLabel(mission, mission.resumeCheckpoint)} exited with code ${result.exitCode}`);
  }

  return { exitCode: result.exitCode, durationMs: result.durationMs, fileCount: blocks.length, model: selectedModel, attemptedModels };
}

// ─── Sub-phase: loop iterations until PASS/WARN or hit cap ───────
async function runSubPhase(ctx, subPhase, opts = {}) {
  const { io, mission, missionDir, saveState } = ctx;
  const room = `mission-${mission.id}`;
  const workdir = opts.workdir || mission.targetProject;
  const inner = { workdir, baseCommit: opts.baseCommit };
  subPhase.status = 'running';
  io.to(room).emit('mission:subphase-start', { id: mission.id, subPhaseId: subPhase.id, title: subPhase.title });
  saveState();

  for (let i = 0; i <= MAX_FIX_ITERATIONS; i++) {
    const iter = { idx: i, startedAt: Date.now(), phases: {}, verdict: null };
    subPhase.iterations.push(iter);

    iter.phases.coding = await runInnerPhase(ctx, subPhase, iter, 'coding', inner);
    saveState();
    iter.phases.review = await runInnerPhase(ctx, subPhase, iter, 'review', inner);
    saveState();

    iter.verdict = readIterationVerdict(missionDir, subPhase, i);
    iter.findingsPath = getIterationFindingsPath(missionDir, subPhase, i, 'review');
    iter.finishedAt = Date.now();
    saveState();

    io.to(room).emit('mission:iteration-end', { id: mission.id, subPhaseId: subPhase.id, iteration: i, verdict: iter.verdict });

    if (iter.verdict === 'PASS') {
      iter.phases.refill = await runInnerPhase(ctx, subPhase, iter, 'refill', inner);
      saveState();
      subPhase.status = 'pass';
      subPhase.finalVerdict = iter.verdict;
      subPhase.finalCommit = safeExec(`git -C "${workdir}" rev-parse HEAD 2>/dev/null`) || null;
      saveState();
      io.to(room).emit('mission:subphase-end', { id: mission.id, subPhaseId: subPhase.id, verdict: iter.verdict });
      return;
    }
    if (iter.verdict === 'WARN') {
      iter.warningPolicy = mission.warningPolicy || 'strict';
      iter.phases.refill = await runInnerPhase(ctx, subPhase, iter, 'refill', inner);
      saveState();

      if (iter.warningPolicy !== 'soft') {
        iter.phases.reviewAfterRefill = await runInnerPhase(ctx, subPhase, iter, 'review', {
          ...inner,
          dirName: 'review-after-refill',
          phaseLabel: 'review-after-refill',
        });
        iter.verdict = readIterationVerdict(missionDir, subPhase, i, 'review-after-refill');
        iter.findingsPath = getIterationFindingsPath(missionDir, subPhase, i, 'review-after-refill');
        saveState();
        io.to(room).emit('mission:iteration-end', { id: mission.id, subPhaseId: subPhase.id, iteration: i, verdict: iter.verdict, afterRefill: true });
      }

      if (iter.verdict === 'PASS') {
        subPhase.status = 'pass';
        subPhase.finalVerdict = 'PASS';
        subPhase.finalCommit = safeExec(`git -C "${workdir}" rev-parse HEAD 2>/dev/null`) || null;
        saveState();
        io.to(room).emit('mission:subphase-end', { id: mission.id, subPhaseId: subPhase.id, verdict: 'PASS' });
        return;
      }

      if (iter.warningPolicy === 'strict' && i < MAX_FIX_ITERATIONS) {
        io.to(room).emit('mission:warning-fix', { id: mission.id, subPhaseId: subPhase.id, iteration: i, nextIteration: i + 1 });
        continue;
      }

      subPhase.status = 'warn';
      subPhase.finalVerdict = 'WARN';
      subPhase.finalCommit = safeExec(`git -C "${workdir}" rev-parse HEAD 2>/dev/null`) || null;
      saveState();
      io.to(room).emit('mission:subphase-end', { id: mission.id, subPhaseId: subPhase.id, verdict: 'WARN' });
      return;
    }
    // FAIL — try next iteration if budget remains
    if (i >= MAX_FIX_ITERATIONS) {
      subPhase.status = 'paused';
      subPhase.finalVerdict = 'FAIL';
      saveState();
      io.to(room).emit('mission:subphase-paused', { id: mission.id, subPhaseId: subPhase.id, iterations: i + 1 });
      throw new Error(`Sub-phase ${subPhase.id} exhausted ${MAX_FIX_ITERATIONS + 1} iterations without PASS/WARN`);
    }
    // continue loop → next iteration uses fix prompt
  }
}

async function continueSubPhaseFromCheckpoint(ctx, subPhase, checkpoint) {
  const { io, mission, missionDir, saveState } = ctx;
  const room = `mission-${mission.id}`;
  subPhase.status = 'running';
  io.to(room).emit('mission:subphase-start', { id: mission.id, subPhaseId: subPhase.id, title: subPhase.title });
  saveState();

  let startIterIdx = Number.isInteger(checkpoint.iteration) ? checkpoint.iteration : 0;
  let startPhase = checkpoint.phase || 'coding';

  for (let i = startIterIdx; i <= MAX_FIX_ITERATIONS; i++) {
    let iter = (subPhase.iterations || []).find((item) => item.idx === i);
    if (!iter) {
      iter = { idx: i, startedAt: Date.now(), phases: {}, verdict: null };
      subPhase.iterations.push(iter);
    }
    if (!iter.phases) iter.phases = {};

    if (startPhase === 'coding') {
      iter.phases.coding = await runInnerPhase(ctx, subPhase, iter, 'coding');
      saveState();
      startPhase = 'review';
    }
    if (startPhase === 'review') {
      iter.phases.review = await runInnerPhase(ctx, subPhase, iter, 'review');
      saveState();
      iter.verdict = readIterationVerdict(missionDir, subPhase, i);
      iter.findingsPath = getIterationFindingsPath(missionDir, subPhase, i, 'review');
      iter.finishedAt = Date.now();
      saveState();
      io.to(room).emit('mission:iteration-end', { id: mission.id, subPhaseId: subPhase.id, iteration: i, verdict: iter.verdict });
      startPhase = (iter.verdict === 'PASS' || iter.verdict === 'WARN') ? 'refill' : 'coding';
    }
    if (startPhase === 'refill') {
      iter.phases.refill = await runInnerPhase(ctx, subPhase, iter, 'refill');
      saveState();
      subPhase.status = iter.verdict === 'PASS' ? 'pass' : 'warn';
      subPhase.finalVerdict = iter.verdict;
      subPhase.finalCommit = safeExec(`git -C "${mission.targetProject}" rev-parse HEAD 2>/dev/null`) || null;
      mission.resumeCheckpoint = null;
      saveState();
      io.to(room).emit('mission:subphase-end', { id: mission.id, subPhaseId: subPhase.id, verdict: iter.verdict });
      return;
    }

    if (i >= MAX_FIX_ITERATIONS) {
      subPhase.status = 'paused';
      subPhase.finalVerdict = 'FAIL';
      saveState();
      io.to(room).emit('mission:subphase-paused', { id: mission.id, subPhaseId: subPhase.id, iterations: i + 1 });
      throw new Error(`Sub-phase ${subPhase.id} exhausted ${MAX_FIX_ITERATIONS + 1} iterations without PASS/WARN`);
    }
    startPhase = 'coding';
  }
}

// ─── Final summary ──────────────────────────────────────────────
async function runFinalSummary(ctx) {
  const { io, mission, missionDir, sysPrompts, saveState } = ctx;
  const room = `mission-${mission.id}`;
  const plan = fs.readFileSync(path.join(missionDir, 'plan.md'), 'utf8');
  const gitLog = safeExec(`git -C "${mission.targetProject}" log --oneline ${mission.startCommit}..HEAD 2>/dev/null`);
  const promptRoleKeys = setPromptActiveRoles(mission, 'final-summary', plan, saveState);

  let prompt = sysPrompts.finalSummary.trim();
  const brief = compactAgentBriefForStage(
    mission.intelligence && mission.intelligence.roster,
    'final-summary',
    plan,
  );
  if (brief) prompt += '\n\n---\n\n' + brief;
  prompt += '\n\n---\n\n# Mission metadata\n\n';
  prompt += `Mission title: ${mission.title}\n`;
  prompt += `Mission id: ${mission.id}\n`;
  prompt += `Created: ${new Date(mission.createdAt).toISOString()}\n`;
  prompt += `Project: ${mission.targetProject}\n`;
  prompt += `Baseline: ${mission.startCommit}\n\n`;
  prompt += '## Sub-phases\n\n';
  for (const sp of mission.subPhases) {
    prompt += `### ${sp.id} — ${sp.title}\n`;
    prompt += `- Status: ${sp.status}\n`;
    prompt += `- Final verdict: ${sp.finalVerdict || '-'}\n`;
    prompt += `- Iterations: ${sp.iterations.length}\n`;
    prompt += `- Final commit: ${sp.finalCommit || '-'}\n\n`;
    // attach latest findings.md if exists
    const lastIter = sp.iterations[sp.iterations.length - 1];
    if (lastIter) {
      const findingsPath = path.join(missionDir, `sub-${sp.id}`, `iteration-${lastIter.idx}`, 'review', 'artifacts', 'findings.md');
      if (fs.existsSync(findingsPath)) {
        prompt += `Latest findings for ${sp.id}:\n\n`;
        prompt += fs.readFileSync(findingsPath, 'utf8') + '\n\n';
      }
    }
  }
  prompt += `\n## Full git log (since baseline)\n\n\`\`\`\n${gitLog}\n\`\`\`\n`;

  const result = await runAgentWithObserver({
    io, room, mission,
    phaseLabel: 'final-summary',
    model: mission.models.finalSummary || 'opus',
    prompt,
    transcriptPath: path.join(missionDir, 'final-summary', 'transcript.log'),
    progressContext: { stage: 'final-summary', promptRoleKeys },
    workspaceKind: 'summary',
    saveState,
  });
  fs.writeFileSync(path.join(missionDir, 'final-summary', 'raw-output.txt'), result.stdout);

  const blocks = parseFileBlocks(result.stdout);
  for (const b of blocks) {
    fs.writeFileSync(path.join(missionDir, b.path), b.content);  // final-summary.md goes to mission root
  }
  mission.finalSummary = { exitCode: result.exitCode, durationMs: result.durationMs, path: path.join(missionDir, 'final-summary.md') };
}

// ─── Parallel execution: dependency waves + git worktree isolation ──
// Each wave runs its sub-phases concurrently, each in its own worktree off a
// shared base commit. Between waves (barrier) the branches are merged back
// serially; the next wave builds on the merged HEAD. Clean merge → keep;
// conflict (a collision the planner missed) → downgrade to serial rebuild.
async function runExecutionParallel(ctx) {
  const { io, mission, missionDir, saveState } = ctx;
  const room = `mission-${mission.id}`;
  const { planWaves } = require('./mission-wave-planner');
  const worktree = require('./mission-worktree');
  const maxConc = Math.max(1, Number(process.env.MISSION_PARALLEL_MAX || 3) || 3);

  let plan;
  try {
    plan = planWaves(mission.subPhases, { maxConcurrency: maxConc });
  } catch (err) {
    throw new Error(`Parallel planning failed: ${err.message}`);
  }
  mission.parallel = {
    enabled: true,
    maxConcurrency: maxConc,
    waves: plan.waves.map((w) => w.map((sp) => sp.id)),
    warnings: plan.warnings,
  };
  saveState();
  io.to(room).emit('mission:parallel-plan', {
    id: mission.id,
    waves: mission.parallel.waves,
    warnings: plan.warnings,
    maxConcurrency: maxConc,
  });

  const repo = mission.targetProject;
  // Worktrees MUST live outside the repo working tree — missionDir is inside
  // targetProject/missions/, so putting them there would pollute git status.
  const os = require('os');
  const wtRoot = path.join(os.tmpdir(), 'orca-mission-wt', String(mission.id));
  ensureDir(wtRoot);
  let baseCommit = safeExec(`git -C "${repo}" rev-parse HEAD 2>/dev/null`) || mission.startCommit;
  const failures = [];
  const serialFallback = [];

  for (let w = 0; w < plan.waves.length; w++) {
    const wave = plan.waves[w];
    io.to(room).emit('mission:wave-start', {
      id: mission.id, wave: w + 1, total: plan.waves.length,
      subPhaseIds: wave.map((sp) => sp.id),
    });

    const settled = await Promise.allSettled(wave.map(async (spStub) => {
      const subPhase = mission.subPhases.find((s) => s.id === spStub.id);
      if (!subPhase || ['pass', 'warn'].includes(subPhase.status)) {
        return { subPhase, skipped: true };
      }
      // Fresh attempt for this sub-phase. Also clears any leftovers from a
      // crashed prior run so resume rebuilds cleanly in its worktree.
      subPhase.iterations = [];
      subPhase.status = 'queued';
      subPhase.finalVerdict = null;
      subPhase.finalCommit = null;
      const branch = `mission/${mission.id}/sub-${subPhase.id}`;
      const dir = path.join(wtRoot, `sub-${subPhase.id}`);
      try {
        worktree.createWorktree({ repo, baseCommit, branch, dir });
        subPhase.worktree = { dir, branch, baseCommit };
        saveState();
        await runSubPhase(ctx, subPhase, { workdir: dir, baseCommit });
        worktree.commitWorktree({ dir, message: `mission ${mission.id} sub-${subPhase.id}` });
        return { subPhase, branch, dir, ok: true };
      } catch (err) {
        return { subPhase, branch, dir, ok: false, error: err };
      }
    }));

    // Barrier: merge each completed worktree back serially, then clean up.
    for (const res of settled) {
      const v = res.status === 'fulfilled' ? res.value : { ok: false, error: res.reason };
      if (!v || v.skipped) continue;
      const { subPhase, branch, dir } = v;
      if (!v.ok) {
        failures.push({ id: subPhase && subPhase.id, error: v.error && v.error.message });
        if (subPhase && !['pass', 'warn'].includes(subPhase.status)) {
          subPhase.status = 'paused';
          subPhase.finalVerdict = subPhase.finalVerdict || 'FAIL';
        }
        worktree.removeWorktree({ repo, dir, branch, quiet: true });
        saveState();
        continue;
      }
      const merge = worktree.mergeWorktree({ repo, branch, message: `mission ${mission.id}: merge sub-${subPhase.id}` });
      worktree.removeWorktree({ repo, dir, branch });
      if (!merge.ok && merge.conflict) {
        io.to(room).emit('mission:wave-conflict', {
          id: mission.id, subPhaseId: subPhase.id, conflictFiles: merge.conflictFiles,
        });
        serialFallback.push(subPhase);
      }
      saveState();
    }

    baseCommit = safeExec(`git -C "${repo}" rev-parse HEAD 2>/dev/null`) || baseCommit;
    io.to(room).emit('mission:wave-end', { id: mission.id, wave: w + 1 });
  }

  // Conflicted sub-phases the planner missed → serial rebuild on the merged base.
  for (const subPhase of serialFallback) {
    subPhase.iterations = [];
    subPhase.status = 'queued';
    subPhase.finalVerdict = null;
    subPhase.finalCommit = null;
    saveState();
    await runSubPhase(ctx, subPhase); // workdir defaults to shared targetProject
  }

  mission.currentSubPhaseIdx = null;
  saveState();
  if (failures.length) {
    throw new Error(`Parallel execution: ${failures.length} sub-phase(s) failed without recovery: ${failures.map((f) => f.id).join(', ')}`);
  }
}

async function runExecutionAndSummary(ctx, startIndex = 0, resumeCheckpoint = null) {
  const { io, mission, saveState } = ctx;
  const room = `mission-${mission.id}`;

  mission.status = 'executing';
  saveState();

  // Parallel path: a fresh full run with the flag on, OR resuming a mission that
  // was already running in parallel (runExecutionParallel skips done sub-phases,
  // so re-entry is idempotent — it just picks up the unfinished waves). Flag-off
  // and sequential missions fall through to the loop below (unchanged).
  const hasUnfinished = mission.subPhases.some((sp) => !['pass', 'warn'].includes(sp.status));
  const freshParallel = process.env.MISSION_PARALLEL === '1' && startIndex === 0 && !resumeCheckpoint;
  const resumeParallel = mission.parallel && mission.parallel.enabled && hasUnfinished;
  if (freshParallel || resumeParallel) {
    await runExecutionParallel(ctx);
  } else {
    for (let i = startIndex; i < mission.subPhases.length; i++) {
      const subPhase = mission.subPhases[i];
      mission.currentSubPhaseIdx = i;
      saveState();

      if (i === startIndex && resumeCheckpoint && resumeCheckpoint.phase) {
        await continueSubPhaseFromCheckpoint(ctx, subPhase, resumeCheckpoint);
      } else if (!['pass', 'warn'].includes(subPhase.status)) {
        await runSubPhase(ctx, subPhase);
      }
    }
    mission.currentSubPhaseIdx = null;
  }

  mission.resumeCheckpoint = { stage: 'summary', updatedAt: Date.now() };
  mission.status = 'summarizing';
  saveState();
  io.to(room).emit('mission:summary-start', { id: mission.id });
  await runFinalSummary(ctx);
  mission.resumeCheckpoint = null;
  mission.status = 'done';
  mission.finishedAt = Date.now();
  saveState();
  io.to(room).emit('mission:done', { id: mission.id });
}

async function notifyMissionComplete(mission, missionDir) {
  const passCount = mission.subPhases.filter((sp) => sp.finalVerdict === 'PASS').length;
  const warnCount = mission.subPhases.filter((sp) => sp.finalVerdict === 'WARN').length;
  const failCount = mission.subPhases.filter((sp) => sp.finalVerdict === 'FAIL').length;
  const elapsedMin = Math.round((Date.now() - mission.createdAt) / 60000);
  const msg = [
    `✅ *Mission complete*: ${mission.title}`,
    ``,
    `📊 Sub-phases: ${passCount}✓ / ${warnCount}⚠ / ${failCount}✗`,
    `⏱ Total: ${elapsedMin} min`,
    `📋 Summary: \`${missionDir}/final-summary.md\``,
    ``,
    `_Mission id_: \`${mission.id}\``,
  ].join('\n');
  await telegram.sendMessage(msg);
}

async function handleMissionError(ctx, err) {
  const { io, mission, missionDir, saveState } = ctx;
  const room = `mission-${mission.id}`;
  mission.status = mission.status === 'planning' ? 'error' : 'paused_for_human';
  mission.error = err.message;
  saveState();
  io.to(room).emit('mission:error', {
    id: mission.id,
    phase: mission.resumeCheckpoint && mission.resumeCheckpoint.phase,
    error: err.message,
    resumeCheckpoint: mission.resumeCheckpoint || null,
  });
  const elapsedMin = Math.round((Date.now() - mission.createdAt) / 60000);
  await telegram.sendMessage(`⚠️ *Mission paused*: ${mission.title}\n\n${err.message}\n\nResume: ${checkpointLabel(mission, mission.resumeCheckpoint)}\nElapsed: ${elapsedMin} min\nID: \`${mission.id}\``);
  throw err;
}

// ─── Top-level orchestrator ─────────────────────────────────────
async function runAutoOrchestrator(ctx) {
  const { io, mission, missionDir, saveState } = ctx;
  const room = `mission-${mission.id}`;

  try {
    if (!mission.contextScout || !mission.contextScout.pathMd) {
      await runContextScout(ctx);
    }

    mission.status = 'planning';
    saveState();
    io.to(room).emit('mission:planner-start', { id: mission.id });
    await runPlanner(ctx);
    saveState();
    io.to(room).emit('mission:planner-end', { id: mission.id, count: mission.subPhases.length });

    await runExecutionAndSummary(ctx, 0, null);
    await notifyMissionComplete(mission, missionDir);
  } catch (err) {
    await handleMissionError(ctx, err);
  }
}

async function resumeAutoOrchestrator(ctx) {
  const { mission, missionDir, saveState } = ctx;
  if (isRunningStatus(mission.status)) {
    throw new Error(`mission is already ${mission.status}`);
  }

  try {
    mission.error = null;
    const checkpoint = findResumeCheckpoint(mission);
    if (checkpoint.stage === 'preflight') {
      await runAutoOrchestrator(ctx);
      return;
    }
    if (checkpoint.stage === 'planner') {
      await runAutoOrchestrator(ctx);
      return;
    }
    if (checkpoint.stage === 'summary') {
      mission.resumeCheckpoint = { stage: 'summary', updatedAt: Date.now() };
      await runExecutionAndSummary(ctx, mission.subPhases.length, null);
      await notifyMissionComplete(mission, missionDir);
      return;
    }

    const startIndex = Number.isInteger(checkpoint.subPhaseIdx)
      ? checkpoint.subPhaseIdx
      : mission.subPhases.findIndex((sp) => sp.id === checkpoint.subPhaseId);
    if (startIndex < 0) throw new Error('resume checkpoint points to missing sub-phase');

    mission.resumeCheckpoint = checkpoint;
    saveState();
    await runExecutionAndSummary(ctx, startIndex, checkpoint);
    await notifyMissionComplete(mission, missionDir);
  } catch (err) {
    await handleMissionError(ctx, err);
  }
}

module.exports = { runAutoOrchestrator, resumeAutoOrchestrator, findResumeCheckpoint, MAX_FIX_ITERATIONS };
