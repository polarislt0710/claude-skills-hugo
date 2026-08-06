/**
 * codex-watchdog — locate and read the official codex-companion state.
 *
 * We never import the official plugin's code (its path moves with every
 * version). We only read/write its on-disk format, guarded by the `version`
 * field in state.json.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { isTerminalStatus, parseTimestampMs } from "./classify.mjs";
import { scanForSandboxDeny } from "./deny-scan.mjs";

export const SUPPORTED_STATE_VERSION = 1;
export const STATE_FILE_NAME = "state.json";
export const JOBS_DIR_NAME = "jobs";

function isDirectory(candidate) {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Mirrors the official workspace.mjs / git.mjs behaviour: git toplevel, else cwd.
 */
export function resolveWorkspaceRoot(cwd) {
  try {
    const output = execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
    const trimmed = output.trim();
    return trimmed || cwd;
  } catch {
    return cwd;
  }
}

/**
 * Mirrors the official state.mjs `resolveStateDir` naming: `<slug>-<hash16>`.
 */
export function computeStateDirName(workspaceRoot) {
  let canonical = workspaceRoot;
  try {
    canonical = fs.realpathSync.native(workspaceRoot);
  } catch {
    canonical = workspaceRoot;
  }
  const slugSource = path.basename(workspaceRoot) || "workspace";
  const slug =
    slugSource.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 16);
  return `${slug}-${hash}`;
}

/**
 * Candidate roots that may hold `<slug>-<hash>` state dirs:
 *   ~/.claude/plugins/data/<namespace>/state/  (all namespaces)
 *   $TMPDIR/codex-companion/                   (official fallback)
 */
export function candidateStateRoots({ homeDir = os.homedir(), tmpDir = os.tmpdir() } = {}) {
  const roots = [];
  const pluginData = path.join(homeDir, ".claude", "plugins", "data");
  let entries = [];
  try {
    entries = fs.readdirSync(pluginData, { withFileTypes: true });
  } catch {
    entries = [];
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const stateRoot = path.join(pluginData, entry.name, "state");
    if (isDirectory(stateRoot)) roots.push(stateRoot);
  }
  const fallback = path.join(tmpDir, "codex-companion");
  if (isDirectory(fallback)) roots.push(fallback);
  return roots;
}

/**
 * @returns {{ workspaceRoot: string, stateDirName: string|null, stateDirs: string[] }}
 * @throws when nothing is found (AC10 — never silently return an empty list).
 */
export function resolveCodexStateDirs(cwd, options = {}) {
  const { stateDir = null, homeDir = os.homedir(), tmpDir = os.tmpdir() } = options;

  if (stateDir) {
    const resolved = path.resolve(stateDir);
    if (!isDirectory(resolved)) {
      throw new Error(`codex-watchdog: --state-dir "${resolved}" does not exist or is not a directory.`);
    }
    return {
      workspaceRoot: options.workspaceRoot ?? resolveWorkspaceRoot(cwd),
      stateDirName: path.basename(resolved),
      stateDirs: [resolved]
    };
  }

  const workspaceRoot = options.workspaceRoot ?? resolveWorkspaceRoot(cwd);
  const stateDirName = computeStateDirName(workspaceRoot);
  const roots = candidateStateRoots({ homeDir, tmpDir });
  const stateDirs = [];
  for (const root of roots) {
    const candidate = path.join(root, stateDirName);
    if (isDirectory(candidate)) stateDirs.push(candidate);
  }

  if (stateDirs.length === 0) {
    throw new Error(
      [
        `codex-watchdog: no codex-companion state directory found for workspace "${workspaceRoot}".`,
        `Expected a directory named "${stateDirName}" under one of:`,
        ...(roots.length ? roots.map((root) => `  - ${root}`) : ["  (no candidate roots exist on this machine)"]),
        "Pass --state-dir <path> to point at the state directory explicitly."
      ].join("\n")
    );
  }

  return { workspaceRoot, stateDirName, stateDirs };
}

export function resolveStateFile(stateDir) {
  return path.join(stateDir, STATE_FILE_NAME);
}

export function resolveJobsDir(stateDir) {
  return path.join(stateDir, JOBS_DIR_NAME);
}

export function resolveJobFile(stateDir, jobId) {
  return path.join(resolveJobsDir(stateDir), `${jobId}.json`);
}

/**
 * Read state.json. Fails loud on missing file, bad JSON, or unknown version (AC8).
 */
export function readStateFile(stateDir) {
  const stateFile = resolveStateFile(stateDir);
  let raw;
  try {
    raw = fs.readFileSync(stateFile, "utf8");
  } catch (error) {
    throw new Error(`codex-watchdog: cannot read ${stateFile}: ${error.message}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`codex-watchdog: ${stateFile} is not valid JSON: ${error.message}`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`codex-watchdog: ${stateFile} must contain a JSON object.`);
  }

  if (parsed.version !== SUPPORTED_STATE_VERSION) {
    throw new Error(
      `codex-watchdog: unsupported codex state format version ${JSON.stringify(parsed.version)} in ${stateFile} ` +
        `(this build only understands version ${SUPPORTED_STATE_VERSION}). ` +
        "The official codex plugin probably changed its on-disk format — update codex-watchdog before trusting it."
    );
  }

  return {
    version: parsed.version,
    config: parsed.config && typeof parsed.config === "object" ? parsed.config : {},
    jobs: Array.isArray(parsed.jobs) ? parsed.jobs : [],
    stateFile,
    raw: parsed
  };
}

export function readJobFile(stateDir, jobId) {
  const jobFile = resolveJobFile(stateDir, jobId);
  let raw;
  try {
    raw = fs.readFileSync(jobFile, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Fields that describe *where the job is now*. Everything else (request,
 * workspaceRoot, logFile, …) is immutable-ish and can come from either side.
 */
const STATUS_FIELDS = Object.freeze([
  "status",
  "phase",
  "pid",
  "startedAt",
  "completedAt",
  "updatedAt",
  "errorMessage",
  "summary",
  "threadId",
  "turnId",
  "result"
]);

function recencyMs(record) {
  const candidates = [record?.completedAt, record?.updatedAt, record?.startedAt, record?.createdAt]
    .map(parseTimestampMs)
    .filter((value) => value !== null);
  return candidates.length ? Math.max(...candidates) : null;
}

/**
 * Merge a state.json entry with its jobs/<id>.json file.
 *
 * `state.json` and `jobs/<id>.json` are two independent reads, and the official
 * worker writes the job file FIRST and state.json second (tracked-jobs.mjs
 * `runTrackedJob`). So a naive `{...jobFile, ...entry}` lets a stale state entry
 * (status running, pid 1234) beat a job file that already says `completed` —
 * and a completed job then gets classified `dead` and reaped as failed.
 *
 * Rule: a terminal record beats an active one; between two records of the same
 * finality the newer timestamp wins; ties keep the state entry (previous
 * behaviour). `statusSource` records which side won, for evidence.
 */
export function mergeJobRecord(entry, jobFile, stateDir) {
  const merged = { ...(jobFile ?? {}), ...(entry ?? {}), stateDir };

  if (!entry) return { ...merged, statusSource: jobFile ? "jobFile" : "none" };
  if (!jobFile) return { ...merged, statusSource: "state" };

  const entryTerminal = isTerminalStatus(entry.status);
  const fileTerminal = isTerminalStatus(jobFile.status);

  let winner = "state";
  if (fileTerminal && !entryTerminal) {
    winner = "jobFile";
  } else if (!entryTerminal || fileTerminal) {
    const entryMs = recencyMs(entry);
    const fileMs = recencyMs(jobFile);
    if (fileMs !== null && (entryMs === null || fileMs > entryMs)) winner = "jobFile";
  }

  if (winner === "jobFile") {
    for (const field of STATUS_FIELDS) {
      if (field in jobFile) merged[field] = jobFile[field];
    }
  }

  merged.statusSource = winner;
  return merged;
}

/**
 * Merge state.json entries with their per-job files (see mergeJobRecord).
 */
export function loadJobs(stateDir) {
  const state = readStateFile(stateDir);
  return state.jobs.map((entry) =>
    mergeJobRecord(entry, entry && entry.id ? readJobFile(stateDir, entry.id) : null, stateDir)
  );
}

export function loadJobsFromStateDirs(stateDirs) {
  const jobs = [];
  for (const stateDir of stateDirs) {
    jobs.push(...loadJobs(stateDir));
  }
  return jobs;
}

/**
 * `process.kill(pid, 0)`:
 *   ESRCH → no such process → dead
 *   EPERM → process exists but is not ours → alive
 */
export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error && error.code === "EPERM") return true;
    return false;
  }
}

/**
 * A pid on its own proves nothing: the OS recycles pids, so a dead worker's
 * 1234 can belong to some unrelated long-lived process and `kill(pid, 0)` will
 * happily report "alive" forever.
 *
 * Cheap extra identity check: a process cannot have started before the job it
 * is supposedly running. If the process start time is older than the job start
 * time (minus a generous tolerance) it is definitely a different process.
 *
 * The tolerance is deliberately large. A false "alive" only delays recovery;
 * a false "dead" makes reap mark a *running* job as failed, which is far worse.
 * Real pid recycling victims are long-lived daemons, so 5 minutes still catches
 * them while leaving normal dispatch latency (worker starts, then writes
 * startedAt seconds later) untouched.
 */
export const PID_START_TOLERANCE_MS = 5 * 60_000;

// Short-lived cache so one CLI invocation (or one watch poll) does not fork
// `ps` once per job. The TTL keeps a long-running `watch` from trusting a start
// time for a pid that has since been recycled.
const processStartCache = new Map();
export const PID_START_CACHE_TTL_MS = 30_000;

/**
 * Process start time in epoch ms, or null when the platform will not tell us
 * (Windows, `ps` missing, unparseable output) — callers must degrade to the
 * plain liveness check in that case.
 */
export function readProcessStartMs(pid, { cache = processStartCache, nowMs = Date.now() } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const cached = cache?.get(pid);
  if (cached && nowMs - cached.readAtMs < PID_START_CACHE_TTL_MS) return cached.value;

  let value = null;
  try {
    const output = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000
    }).trim();
    if (output) {
      const parsed = Date.parse(output);
      if (!Number.isNaN(parsed)) value = parsed;
    }
  } catch {
    value = null;
  }

  cache?.set(pid, { value, readAtMs: nowMs });
  return value;
}

/**
 * @returns {{pidIdentityVerified: boolean, processStartMs: number|null, pidReuseSuspected: boolean}}
 */
export function verifyPidIdentity(pid, jobStartMs, options = {}) {
  const {
    processStartMs = readProcessStartMs(pid),
    toleranceMs = PID_START_TOLERANCE_MS
  } = options;

  if (processStartMs === null || !Number.isFinite(jobStartMs)) {
    return { pidIdentityVerified: false, processStartMs: processStartMs ?? null, pidReuseSuspected: false };
  }
  return {
    pidIdentityVerified: true,
    processStartMs,
    pidReuseSuspected: processStartMs < jobStartMs - toleranceMs
  };
}

export function readLogMtimeMs(logFile) {
  if (!logFile || typeof logFile !== "string") return null;
  try {
    return fs.statSync(logFile).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * The impure half of classification — kept out of classify.mjs on purpose.
 */
export function probeJob(job) {
  const pid = Number.isInteger(job?.pid) ? job.pid : null;
  const pidAlive = pid === null ? false : isPidAlive(pid);

  let identity = { pidIdentityVerified: false, processStartMs: null, pidReuseSuspected: false };
  if (pidAlive && pid !== null) {
    const jobStartMs = parseTimestampMs(job?.startedAt) ?? parseTimestampMs(job?.createdAt);
    if (jobStartMs !== null) identity = verifyPidIdentity(pid, jobStartMs);
  }

  return {
    pidAlive,
    ...identity,
    logMtimeMs: readLogMtimeMs(job?.logFile)
  };
}

export const DENY_SCAN_BYTES = 256 * 1024;

/**
 * Read the last `maxBytes` of a log file as lines. Used by the sandbox-deny
 * scanner so huge logs never get slurped whole.
 */
export function readLogTailBytes(logFile, maxBytes = DENY_SCAN_BYTES) {
  if (!logFile || typeof logFile !== "string") return [];
  let handle;
  try {
    handle = fs.openSync(logFile, "r");
  } catch {
    return [];
  }
  try {
    const size = fs.fstatSync(handle).size;
    const length = Math.min(size, maxBytes);
    if (length <= 0) return [];
    const buffer = Buffer.allocUnsafe(length);
    fs.readSync(handle, buffer, 0, length, size - length);
    return buffer.toString("utf8").split("\n");
  } catch {
    return [];
  } finally {
    try {
      fs.closeSync(handle);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Annotation only — see deny-scan.mjs. Never feeds back into classification.
 */
export function scanJobForSandboxDeny(job) {
  return scanForSandboxDeny(readLogTailBytes(job?.logFile));
}

export function readLogTail(logFile, lineCount = 5) {
  if (!logFile || typeof logFile !== "string") return [];
  let raw;
  try {
    raw = fs.readFileSync(logFile, "utf8");
  } catch {
    return [];
  }
  const lines = raw.split("\n").filter((line) => line.trim() !== "");
  return lines.slice(-lineCount);
}
