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
 * Merge state.json entries with their per-job files.
 * Job files carry `request` (effort tier); state.json entries carry the
 * freshest status/summary — so the state entry wins on conflicts.
 */
export function loadJobs(stateDir) {
  const state = readStateFile(stateDir);
  return state.jobs.map((entry) => {
    const jobFile = entry && entry.id ? readJobFile(stateDir, entry.id) : null;
    return {
      ...(jobFile ?? {}),
      ...entry,
      stateDir
    };
  });
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
  return {
    pidAlive: pid === null ? false : isPidAlive(pid),
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
