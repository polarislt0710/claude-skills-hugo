/**
 * Test fixtures — build throwaway codex-companion state dirs under os.tmpdir().
 * Nothing here ever touches ~/.claude/plugins/data.
 */
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const WATCHDOG_CLI = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "scripts",
  "watchdog.mjs"
);

const cleanupPaths = new Set();

export function makeTempDir(prefix = "codex-watchdog-test-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanupPaths.add(dir);
  return dir;
}

export function cleanupAll() {
  for (const dir of cleanupPaths) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  cleanupPaths.clear();
}

export function iso(msOffsetFromNow = 0) {
  return new Date(Date.now() + msOffsetFromNow).toISOString();
}

/**
 * Shape copied from a real zombie job record (verified 2026-08-06).
 */
export function makeJob(overrides = {}) {
  return {
    id: "task-ms7i7ifh-txrfie",
    status: "running",
    phase: "running",
    pid: 23748,
    kind: "task",
    kindLabel: "rescue",
    title: "Codex Task",
    write: false,
    sessionId: "08eac933-c346-492b-93c5-604ff4e86169",
    threadId: "019fb30c-6af2-7f62-81e5-2ea3e80fd91d",
    request: null,
    createdAt: iso(-60_000),
    startedAt: iso(-60_000),
    updatedAt: iso(-60_000),
    summary: null,
    ...overrides
  };
}

/**
 * @param {object[]} jobs
 * @param {object} options { version, stateRootName, logLines, logAgeMs }
 * @returns {{ stateDir, stateFile, jobsDir, jobs, logFileFor }}
 */
export function createStateDir(jobs = [], options = {}) {
  const { version = 1, root = makeTempDir(), dirName = "fixture-workspace-0123456789abcdef" } = options;
  const stateDir = path.join(root, dirName);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const materialized = jobs.map((job) => {
    const logFile = job.logFile ?? path.join(jobsDir, `${job.id}.log`);
    return { ...job, logFile };
  });

  for (const job of materialized) {
    fs.writeFileSync(path.join(jobsDir, `${job.id}.json`), `${JSON.stringify(job, null, 2)}\n`, "utf8");
    if (job.writeLog !== false) {
      fs.writeFileSync(job.logFile, `[${iso()}] Starting ${job.title ?? "job"}.\n`, "utf8");
    }
  }

  const stateFile = path.join(stateDir, "state.json");
  fs.writeFileSync(
    stateFile,
    `${JSON.stringify(
      {
        version,
        config: { stopReviewGate: false },
        jobs: materialized.map(({ request, writeLog, ...entry }) => entry)
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  return { root, stateDir, stateFile, jobsDir, jobs: materialized };
}

export function setLogAge(logFile, ageMs) {
  const when = new Date(Date.now() - ageMs);
  fs.utimesSync(logFile, when, when);
}

export function readStateJson(stateFile) {
  return JSON.parse(fs.readFileSync(stateFile, "utf8"));
}

export function readJobJson(stateDir, jobId) {
  return JSON.parse(fs.readFileSync(path.join(stateDir, "jobs", `${jobId}.json`), "utf8"));
}

/**
 * Run the CLI in a child process. Always injects an isolated --home-dir so the
 * real ~/.codex-watchdog.json is never read.
 */
export function runCli(args, options = {}) {
  const homeDir = options.homeDir ?? makeTempDir("codex-watchdog-home-");
  const argv = [WATCHDOG_CLI, ...args, "--home-dir", homeDir];
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      argv,
      {
        encoding: "utf8",
        timeout: options.timeout ?? 30_000,
        ...(options.env ? { env: options.env } : {})
      },
      (error, stdout, stderr) => {
        resolve({ code: error?.code ?? 0, stdout, stderr, error, homeDir });
      }
    );
  });
}

/**
 * Write a fake `codex` executable into a fresh dir and return { dir, env }.
 * Tests prepend `dir` to PATH so the worker never reaches the real Codex CLI.
 */
export function makeFakeCodex({ exitCode = 0, stdout = "", stderr = "", argsFile = null } = {}) {
  const dir = makeTempDir("codex-watchdog-fakebin-");
  const target = path.join(dir, "codex");
  const script = [
    "#!/bin/sh",
    argsFile ? `printf '%s\\n' "$@" > ${JSON.stringify(argsFile)}` : "",
    stdout ? `printf '%s\\n' ${JSON.stringify(stdout)}` : "",
    stderr ? `printf '%s\\n' ${JSON.stringify(stderr)} 1>&2` : "",
    `exit ${exitCode}`,
    ""
  ]
    .filter(Boolean)
    .join("\n");
  fs.writeFileSync(target, script, "utf8");
  fs.chmodSync(target, 0o755);
  return {
    dir,
    binary: target,
    env: { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH ?? ""}` }
  };
}

/** Poll a predicate until it returns truthy or the deadline passes. */
export async function waitFor(predicate, { timeoutMs = 15_000, intervalMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("waitFor: timed out");
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

export function parseCliJson(result) {
  const line = result.stdout.trim();
  if (!line) throw new Error(`no stdout JSON. stderr:\n${result.stderr}`);
  return JSON.parse(line);
}

/** Spawn the CLI without waiting — used by the watch tests. */
export function spawnCli(args, options = {}) {
  const homeDir = options.homeDir ?? makeTempDir("codex-watchdog-home-");
  const child = spawn(process.execPath, [WATCHDOG_CLI, ...args, "--home-dir", homeDir], {
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const done = new Promise((resolve) => {
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
  return { child, done, get stdout() { return stdout; }, get stderr() { return stderr; } };
}

export function patchStateJson(stateFile, jobId, patch) {
  const state = readStateJson(stateFile);
  state.jobs = state.jobs.map((job) => (job.id === jobId ? { ...job, ...patch } : job));
  fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}
