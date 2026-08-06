/**
 * codex-watchdog — bypass dispatch.
 *
 * WHY THIS EXISTS
 * The official openai-codex plugin hard-overrides the Codex sandbox for every
 * job it dispatches (`read-only` or `workspace-write`) together with
 * `approvalPolicy: "never"`. The user's own `~/.codex/config.toml`
 * (`danger-full-access`) has no effect on plugin-dispatched work, so jobs that
 * genuinely need network or out-of-workspace access die silently.
 *
 * `dispatch --bypass` is the escape hatch for exactly that case, and nothing
 * else: normal work still goes through the official plugin (`/codex:rescue`).
 *
 * The on-disk layout is byte-compatible with the official codex-companion
 * format (state.json version 1 + jobs/<id>.json + jobs/<id>.log) so the
 * existing check / watch / reap commands pick these jobs up for free — they
 * live under watchdog's own plugin-data namespace,
 * `~/.claude/plugins/data/codex-watchdog/state/<slug>-<hash>/`.
 *
 * We never import the official plugin's code (its cache path moves with every
 * version); we only mirror its file format.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { isTerminalStatus } from "./classify.mjs";
import { readJsonFileOrNull, updateJsonFileAtomic, writeJsonFileAtomic } from "./json-store.mjs";
import {
  SUPPORTED_STATE_VERSION,
  computeStateDirName,
  mergeJobRecord,
  readStateFile,
  resolveJobFile,
  resolveJobsDir,
  resolveStateFile,
  resolveWorkspaceRoot
} from "./state-locator.mjs";

export const WATCHDOG_DATA_NAMESPACE = "codex-watchdog";
export const BYPASS_JOB_KIND = "bypass-task";
export const RAW_OUTPUT_TAIL_BYTES = 8 * 1024;
export const STDERR_TAIL_CHARS = 2000;

export function nowIso() {
  return new Date().toISOString();
}

export function generateBypassJobId() {
  const random = Math.random().toString(36).slice(2, 8);
  return `bypass-${Date.now().toString(36)}-${random}`;
}

/**
 * `~/.claude/plugins/data/codex-watchdog/state/<slug>-<hash>`
 * The <slug>-<hash> naming is shared with the official plugin (state-locator
 * computeStateDirName), which is what makes these jobs discoverable by check.
 */
export function resolveBypassStateDir(workspaceRoot, { homeDir = os.homedir() } = {}) {
  return path.join(
    homeDir,
    ".claude",
    "plugins",
    "data",
    WATCHDOG_DATA_NAMESPACE,
    "state",
    computeStateDirName(workspaceRoot)
  );
}

/** Make sure state.json exists so the CAS helpers always have bytes to compare. */
function ensureStateFile(stateDir) {
  const stateFile = resolveStateFile(stateDir);
  if (!fs.existsSync(stateFile)) {
    fs.mkdirSync(stateDir, { recursive: true });
    writeJsonFileAtomic(stateFile, { version: SUPPORTED_STATE_VERSION, config: {}, jobs: [] });
  } else {
    // Fail loud on an unknown on-disk format, exactly like the read path does.
    readStateFile(stateDir);
  }
  return stateFile;
}

export function appendLogLine(logFile, message) {
  const normalized = String(message ?? "").trim();
  if (!logFile || !normalized) return;
  fs.appendFileSync(logFile, `[${nowIso()}] ${normalized}\n`, "utf8");
}

/**
 * Merge a patch into both state.json and jobs/<id>.json.
 *
 * Job file first, then state.json — the same ordering the official worker uses,
 * so a concurrent reader that catches us mid-update sees the job file as the
 * fresher side (which mergeJobRecord already prefers for terminal states).
 * Both writes are atomic; the state.json write is a compare-and-swap.
 */
export function updateBypassJob(stateDir, jobId, patch, options = {}) {
  const timestamp = nowIso();

  const jobFile = resolveJobFile(stateDir, jobId);
  const stored = readJsonFileOrNull(jobFile) ?? {};
  const record = { ...stored, ...patch, id: jobId, updatedAt: timestamp };
  writeJsonFileAtomic(jobFile, record);

  const stateFile = ensureStateFile(stateDir);
  updateJsonFileAtomic(
    stateFile,
    (state) => {
      const jobs = Array.isArray(state.jobs) ? [...state.jobs] : [];
      const index = jobs.findIndex((entry) => entry && entry.id === jobId);
      if (index === -1) {
        jobs.unshift({ id: jobId, createdAt: timestamp, updatedAt: timestamp, ...patch });
      } else {
        jobs[index] = { ...jobs[index], ...patch, updatedAt: timestamp };
      }
      return { ...state, version: SUPPORTED_STATE_VERSION, jobs };
    },
    { onAfterRead: options.onAfterRead ?? null }
  );

  return record;
}

/**
 * Attach the spawned worker's pid — but ONLY while the job is still queued.
 *
 * The parent and the detached worker both write this record. `codex exec` can
 * be fast enough that the worker has already written `completed` by the time
 * the parent gets around to recording the pid; a blind read-modify-write then
 * rolls the record back to `queued` with a pid that is already dead, and the
 * next reap buries a successful job as failed.
 *
 * @returns {{applied: boolean, status: string|null, reason?: string}}
 */
export function setBypassJobPidIfQueued(stateDir, jobId, pid, options = {}) {
  const jobFile = resolveJobFile(stateDir, jobId);
  if (!fs.existsSync(jobFile) && !fs.existsSync(resolveStateFile(stateDir))) {
    return { applied: false, status: null, reason: "job-not-found" };
  }

  const stateFile = ensureStateFile(stateDir);
  let observedStatus = null;

  const outcome = updateJsonFileAtomic(
    stateFile,
    (state) => {
      const jobs = Array.isArray(state.jobs) ? state.jobs : [];
      const entry = jobs.find((item) => item && item.id === jobId);
      const merged = mergeJobRecord(entry, readJsonFileOrNull(jobFile), stateDir);
      observedStatus = merged.status ?? null;
      if (observedStatus !== "queued") {
        return { abort: true, reason: isTerminalStatus(observedStatus) ? "already-terminal" : "not-queued" };
      }
      return {
        ...state,
        jobs: jobs.map((item) => (item && item.id === jobId ? { ...item, pid } : item))
      };
    },
    { onAfterRead: options.onAfterRead ?? null }
  );

  if (!outcome.written) {
    return { applied: false, status: observedStatus, reason: outcome.reason };
  }

  // Same guard on the job file: only stamp the pid while it still reads queued.
  const stored = readJsonFileOrNull(jobFile);
  if (stored && stored.status === "queued") {
    writeJsonFileAtomic(jobFile, { ...stored, pid });
  }

  return { applied: true, status: "queued" };
}

/**
 * Create the queued job record + log file. Does not spawn anything.
 */
export function createBypassJob({ cwd, prompt, model = null, effort = null, homeDir = os.homedir() }) {
  const trimmed = String(prompt ?? "").trim();
  if (!trimmed) {
    throw new Error("codex-watchdog: dispatch requires a prompt (argument or piped stdin).");
  }

  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const stateDir = resolveBypassStateDir(workspaceRoot, { homeDir });
  fs.mkdirSync(resolveJobsDir(stateDir), { recursive: true });

  const id = generateBypassJobId();
  const logFile = path.join(resolveJobsDir(stateDir), `${id}.log`);
  fs.writeFileSync(logFile, "", "utf8");
  // NOTE: watchdog's own log lines must avoid deny-scan trigger words
  // ("sandbox", "denied", …) or every bypass job self-reports as suspected.
  appendLogLine(logFile, "Queued for bypass execution with unrestricted filesystem and networking.");

  const createdAt = nowIso();
  const record = {
    id,
    kind: BYPASS_JOB_KIND,
    kindLabel: "bypass",
    title: "Codex Bypass Task",
    jobClass: "task",
    status: "queued",
    phase: "queued",
    pid: null,
    write: true,
    bypass: true,
    workspaceRoot,
    logFile,
    createdAt,
    updatedAt: createdAt,
    summary: null,
    threadId: null,
    turnId: null,
    request: { prompt: trimmed, bypass: true, model, effort, cwd: workspaceRoot }
  };

  updateBypassJob(stateDir, id, record);
  return { ...record, stateDir };
}

/* ------------------------------------------------------------- codex binary */

function isExecutable(candidate) {
  try {
    const stats = fs.statSync(candidate);
    if (!stats.isFile()) return false;
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve `codex` from PATH. Fails loud — we never silently fall back.
 */
export function resolveCodexBinary(env = process.env) {
  const rawPath = env.PATH ?? env.Path ?? "";
  const dirs = rawPath.split(path.delimiter).filter(Boolean);
  const names = process.platform === "win32" ? ["codex.cmd", "codex.exe", "codex"] : ["codex"];
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (isExecutable(candidate)) return candidate;
    }
  }
  throw new Error(
    "codex-watchdog: `codex` binary not found on PATH. Install the Codex CLI (or fix PATH) before using dispatch --bypass."
  );
}

export function buildCodexArgs({ model = null, effort = null } = {}) {
  const args = ["exec", "--sandbox", "danger-full-access", "--skip-git-repo-check"];
  if (model) args.push("--model", String(model));
  if (effort) args.push("-c", `model_reasoning_effort=${effort}`);
  return args;
}

/* ---------------------------------------------------------------- dispatch */

export function spawnDetachedBypassWorker({ scriptPath, stateDir, jobId, cwd, env = process.env }) {
  const child = spawn(
    process.execPath,
    [scriptPath, "dispatch-worker", "--state-dir", stateDir, "--job-id", jobId],
    {
      cwd,
      env,
      detached: true,
      stdio: "ignore",
      windowsHide: true
    }
  );
  child.unref();
  return child;
}

/* ------------------------------------------------------------------ worker */

function tailString(value, maxChars) {
  const text = String(value ?? "");
  return text.length <= maxChars ? text : text.slice(text.length - maxChars);
}

function tailBytes(chunks, maxBytes) {
  const buffer = Buffer.concat(chunks);
  const sliced = buffer.length <= maxBytes ? buffer : buffer.subarray(buffer.length - maxBytes);
  return sliced.toString("utf8");
}

/**
 * Line-buffered stream → `[ISO] line` appended to the job log (same shape the
 * official plugin writes, so readLogTail / deny-scan work unchanged).
 */
function createLineLogger(logFile) {
  let pending = "";
  return {
    push(chunk) {
      pending += chunk;
      let newline = pending.indexOf("\n");
      while (newline !== -1) {
        appendLogLine(logFile, pending.slice(0, newline));
        pending = pending.slice(newline + 1);
        newline = pending.indexOf("\n");
      }
    },
    flush() {
      if (pending.trim()) appendLogLine(logFile, pending);
      pending = "";
    }
  };
}

/**
 * Run the bypass job to completion. Called by the hidden `dispatch-worker`
 * subcommand inside the detached child process.
 */
export async function runBypassWorker({ stateDir, jobId, env = process.env, spawnFn = spawn }) {
  const jobFile = resolveJobFile(stateDir, jobId);
  if (!fs.existsSync(jobFile)) {
    throw new Error(`codex-watchdog: no stored bypass job found for ${jobId} in ${stateDir}.`);
  }
  const job = JSON.parse(fs.readFileSync(jobFile, "utf8"));
  const request = job?.request;
  if (!request || typeof request !== "object" || !request.prompt) {
    throw new Error(`codex-watchdog: bypass job ${jobId} is missing its request payload.`);
  }
  const logFile = job.logFile ?? path.join(resolveJobsDir(stateDir), `${jobId}.log`);

  updateBypassJob(stateDir, jobId, {
    status: "running",
    phase: "running",
    pid: process.pid,
    startedAt: nowIso()
  });

  let binary;
  try {
    binary = resolveCodexBinary(env);
  } catch (error) {
    appendLogLine(logFile, error.message);
    updateBypassJob(stateDir, jobId, {
      status: "failed",
      phase: "failed",
      pid: null,
      completedAt: nowIso(),
      errorMessage: error.message
    });
    throw error;
  }

  const args = [...buildCodexArgs({ model: request.model, effort: request.effort }), request.prompt];
  appendLogLine(
    logFile,
    "Running codex exec with full access" +
      `${request.model ? `, model=${request.model}` : ""}${request.effort ? `, effort=${request.effort}` : ""}.`
  );

  const child = spawnFn(binary, args, {
    cwd: request.cwd ?? job.workspaceRoot ?? process.cwd(),
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });

  const stdoutLogger = createLineLogger(logFile);
  const stderrLogger = createLineLogger(logFile);
  const stdoutChunks = [];
  let stderrText = "";

  child.stdout.on("data", (chunk) => {
    stdoutChunks.push(Buffer.from(chunk));
    stdoutLogger.push(chunk.toString("utf8"));
  });
  child.stderr.on("data", (chunk) => {
    stderrText += chunk.toString("utf8");
    stderrLogger.push(chunk.toString("utf8"));
  });

  const outcome = await new Promise((resolve) => {
    child.once("error", (error) => resolve({ code: null, spawnError: error }));
    child.once("close", (code, signal) => resolve({ code, signal }));
  });

  stdoutLogger.flush();
  stderrLogger.flush();

  const completedAt = nowIso();
  const rawOutput = tailBytes(stdoutChunks, RAW_OUTPUT_TAIL_BYTES);

  if (outcome.spawnError) {
    const errorMessage = `codex-watchdog: failed to spawn codex: ${outcome.spawnError.message}`;
    appendLogLine(logFile, errorMessage);
    updateBypassJob(stateDir, jobId, {
      status: "failed",
      phase: "failed",
      pid: null,
      completedAt,
      errorMessage,
      result: { rawOutput, bypass: true }
    });
    return { status: "failed", exitCode: null, errorMessage };
  }

  const exitCode = outcome.code ?? 1;
  if (exitCode === 0) {
    appendLogLine(logFile, "Bypass task completed (exit 0).");
    updateBypassJob(stateDir, jobId, {
      status: "completed",
      phase: "done",
      pid: null,
      completedAt,
      summary: "Codex bypass task completed.",
      result: { rawOutput, bypass: true, exitCode: 0 }
    });
    return { status: "completed", exitCode: 0, rawOutput };
  }

  const errorMessage =
    `codex exec exited with code ${exitCode}` +
    (outcome.signal ? ` (signal ${outcome.signal})` : "") +
    (stderrText.trim() ? `: ${tailString(stderrText.trim(), STDERR_TAIL_CHARS)}` : ".");
  appendLogLine(logFile, `Bypass task failed (exit ${exitCode}).`);
  updateBypassJob(stateDir, jobId, {
    status: "failed",
    phase: "failed",
    pid: null,
    completedAt,
    errorMessage,
    result: { rawOutput, bypass: true, exitCode }
  });
  return { status: "failed", exitCode, errorMessage, rawOutput };
}
