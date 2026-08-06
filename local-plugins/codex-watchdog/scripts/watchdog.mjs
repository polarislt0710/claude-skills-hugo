#!/usr/bin/env node
/**
 * codex-watchdog CLI — check / watch / reap / doctor
 *
 * Contract:
 *   stdout = machine-readable JSON only (one object for check/reap/doctor,
 *            exactly one event line for watch).
 *   stderr = everything a human reads.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { loadConfig } from "./lib/config.mjs";
import {
  classify,
  isActionableClassification,
  isDeadClassification,
  isTerminalStatus
} from "./lib/classify.mjs";
import {
  loadJobsFromStateDirs,
  probeJob,
  readLogTail,
  readStateFile,
  resolveCodexStateDirs,
  resolveJobFile,
  resolveStateFile,
  scanJobForSandboxDeny
} from "./lib/state-locator.mjs";
import {
  createBypassJob,
  runBypassWorker,
  spawnDetachedBypassWorker,
  updateBypassJob
} from "./lib/bypass-dispatch.mjs";

const BOOLEAN_FLAGS = new Set(["json", "all", "dryRun", "help", "version", "bypass"]);

const USAGE = `codex-watchdog — detect and recover stuck Codex jobs

Usage:
  watchdog.mjs check  [--cwd <dir>] [--state-dir <dir>] [--json] [--all]
  watchdog.mjs watch  [job-id] [--cwd <dir>] [--state-dir <dir>]
                      [--poll-ms N] [--stall-ms N] [--hard-timeout-ms N] [--max-wait-ms N]
  watchdog.mjs reap   [job-id] [--cwd <dir>] [--state-dir <dir>] [--json] [--dry-run]
  watchdog.mjs doctor [--cwd <dir>] [--state-dir <dir>] [--json]
  watchdog.mjs dispatch --bypass [--model <m>] [--effort <e>] [--cwd <dir>] "<prompt>"

Dispatch:
  \`dispatch\` is ONLY a sandbox escape hatch. The official openai-codex plugin
  hard-overrides the Codex sandbox for the jobs it dispatches, so work that
  genuinely needs network or out-of-workspace access cannot succeed through it.
  For every other kind of Codex work use the official plugin (/codex:rescue).
  --bypass is mandatory and runs codex exec with --sandbox danger-full-access.

Common flags:
  --cwd <dir>        workspace to resolve state for (default: process cwd)
  --state-dir <dir>  skip discovery and use this codex-companion state dir
  --home-dir <dir>   override HOME for config/state discovery (used by tests)
  --json             accepted for symmetry; stdout is always JSON

Config: ~/.codex-watchdog.json  { pollMs, stallMinutes:{low,medium,high,xhigh,default}, hardTimeoutMinutes }
Precedence: CLI flags > config file > defaults.

stdout is always JSON. Human-readable output goes to stderr.
`;

function toCamel(key) {
  return key.replace(/-([a-z0-9])/g, (_, chr) => chr.toUpperCase());
}

export function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      positional.push(...argv.slice(index + 1));
      break;
    }
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const equals = arg.indexOf("=");
    if (equals !== -1) {
      flags[toCamel(arg.slice(2, equals))] = arg.slice(equals + 1);
      continue;
    }
    const key = toCamel(arg.slice(2));
    const next = argv[index + 1];
    if (BOOLEAN_FLAGS.has(key) || next === undefined || next.startsWith("--")) {
      flags[key] = true;
    } else {
      flags[key] = next;
      index += 1;
    }
  }
  return { flags, positional };
}

function numberFlag(flags, key) {
  const value = flags[key];
  if (value === undefined || value === true) return undefined;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    throw new Error(`codex-watchdog: --${key} must be a positive number (got ${JSON.stringify(value)}).`);
  }
  return numeric;
}

function writeJson(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function note(message) {
  process.stderr.write(`${message}\n`);
}

function resolveContext(flags) {
  const cwd = flags.cwd && flags.cwd !== true ? path.resolve(String(flags.cwd)) : process.cwd();
  const stateDir = flags.stateDir && flags.stateDir !== true ? String(flags.stateDir) : null;
  const config = loadConfig(
    {
      pollMs: numberFlag(flags, "pollMs"),
      stallMs: numberFlag(flags, "stallMs"),
      hardTimeoutMs: numberFlag(flags, "hardTimeoutMs")
    },
    { homeDir: flags.homeDir && flags.homeDir !== true ? String(flags.homeDir) : os.homedir() }
  );
  const located = resolveCodexStateDirs(cwd, {
    stateDir,
    homeDir: flags.homeDir && flags.homeDir !== true ? String(flags.homeDir) : os.homedir()
  });
  return { cwd, config, ...located };
}

function summarizeJob(job, classification, evidence) {
  return {
    id: job.id ?? null,
    kind: job.kind ?? null,
    kindLabel: job.kindLabel ?? null,
    title: job.title ?? null,
    status: job.status ?? null,
    phase: job.phase ?? null,
    pid: job.pid ?? null,
    write: job.write ?? null,
    threadId: job.threadId ?? null,
    turnId: job.turnId ?? null,
    sessionId: job.sessionId ?? null,
    summary: job.summary ?? null,
    errorMessage: job.errorMessage ?? null,
    createdAt: job.createdAt ?? null,
    startedAt: job.startedAt ?? null,
    updatedAt: job.updatedAt ?? null,
    completedAt: job.completedAt ?? null,
    logFile: job.logFile ?? null,
    stateDir: job.stateDir ?? null,
    classification,
    evidence
  };
}

function classifyAll(stateDirs, config, nowMs = Date.now()) {
  const jobs = loadJobsFromStateDirs(stateDirs);
  return jobs.map((job) => {
    const probe = probeJob(job);
    const { classification, evidence } = classify(job, probe, config, nowMs);
    // Annotation only — the sandbox-deny scan never changes `classification`.
    evidence.sandboxDeny = scanJobForSandboxDeny(job);
    return { job, classification, evidence, view: summarizeJob(job, classification, evidence) };
  });
}

function sortKey(job) {
  return String(job.updatedAt ?? job.completedAt ?? job.createdAt ?? "");
}

/* ------------------------------------------------------------------ check */

function commandCheck(flags) {
  const { config, workspaceRoot, stateDirs } = resolveContext(flags);
  const all = classifyAll(stateDirs, config);

  let selected = all;
  if (!flags.all) {
    const active = all.filter((item) => !isTerminalStatus(item.job.status));
    const terminal = all
      .filter((item) => isTerminalStatus(item.job.status))
      .sort((left, right) => sortKey(right.job).localeCompare(sortKey(left.job)))
      .slice(0, 10);
    selected = [...active, ...terminal];
  }

  const counts = {};
  for (const item of selected) {
    counts[item.classification] = (counts[item.classification] ?? 0) + 1;
  }

  writeJson({
    command: "check",
    generatedAt: new Date().toISOString(),
    workspaceRoot,
    stateDirs,
    truncated: !flags.all && selected.length < all.length,
    totalJobs: all.length,
    counts,
    jobs: selected.map((item) => item.view)
  });

  note(`[watchdog] workspace: ${workspaceRoot}`);
  note(`[watchdog] state dirs: ${stateDirs.join(", ")}`);
  note(`[watchdog] ${selected.length}/${all.length} job(s) reported.`);
  for (const [classification, count] of Object.entries(counts).sort()) {
    note(`[watchdog]   ${classification}: ${count}`);
  }
  const zombies = selected.filter((item) => isDeadClassification(item.classification));
  if (zombies.length) {
    note(`[watchdog] ${zombies.length} zombie job(s) — run \`watchdog.mjs reap\` to mark them failed.`);
  }
  return 0;
}

/* ------------------------------------------------------------------ watch */

let watchEventEmitted = false;

function emitWatchEvent(payload) {
  if (watchEventEmitted) return;
  watchEventEmitted = true;
  writeJson(payload);
}

function buildWatchEvent(item) {
  const { job, classification, evidence } = item;
  const base = {
    jobId: job.id ?? null,
    classification,
    stateDir: job.stateDir ?? null,
    title: job.title ?? null,
    write: job.write ?? null,
    threadId: job.threadId ?? null,
    resumeHint: { threadId: job.threadId ?? null, sessionId: job.sessionId ?? null }
  };

  const sandboxDeny = evidence?.sandboxDeny ?? { suspected: false, matches: [] };

  if (isTerminalStatus(classification)) {
    const terminal = {
      event: classification,
      ...base,
      summary: job.summary ?? null,
      errorMessage: job.errorMessage ?? null,
      completedAt: job.completedAt ?? null
    };
    // `failed` jobs are where a silent sandbox denial usually surfaces.
    return classification === "failed" ? { ...terminal, sandboxDeny } : terminal;
  }

  if (isDeadClassification(classification)) {
    return { event: "dead", ...base, evidence, sandboxDeny };
  }

  if (classification === "stalled") {
    return { event: "stalled", ...base, evidence, sandboxDeny, logTail: readLogTail(job.logFile, 5) };
  }

  if (classification === "timed-out") {
    return { event: "timed-out", ...base, evidence, logTail: readLogTail(job.logFile, 5) };
  }

  return { event: "unknown", ...base, evidence };
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function commandWatch(flags, positional) {
  const { config, workspaceRoot, stateDirs } = resolveContext(flags);
  const targetId = positional[0] ?? null;
  const maxWaitMs = numberFlag(flags, "maxWaitMs") ?? Infinity;
  const pollMs = config.pollMs;
  const startedAtMs = Date.now();

  note(`[watchdog] watch started — workspace: ${workspaceRoot}`);
  note(`[watchdog] state dirs: ${stateDirs.join(", ")}`);
  note(
    `[watchdog] target: ${targetId ?? "all active jobs"}; poll ${pollMs}ms; ` +
      `hard timeout ${config.hardTimeoutMs}ms; max wait ${maxWaitMs === Infinity ? "∞" : `${maxWaitMs}ms`}`
  );

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      emitWatchEvent({ event: "watch-interrupted", signal, jobId: targetId });
      process.exit(0);
    });
  }

  let firstPoll = true;
  for (;;) {
    const all = classifyAll(stateDirs, config);
    const targets = targetId
      ? all.filter((item) => item.job.id === targetId)
      : all.filter((item) => !isTerminalStatus(item.job.status));

    if (targetId && targets.length === 0) {
      emitWatchEvent({
        event: "nothing-to-watch",
        reason: firstPoll ? "job-not-found" : "job-record-disappeared",
        jobId: targetId,
        workspaceRoot,
        stateDirs
      });
      return 0;
    }

    if (targets.length === 0) {
      emitWatchEvent({
        event: "nothing-to-watch",
        reason: "no-active-jobs",
        workspaceRoot,
        stateDirs
      });
      return 0;
    }

    const actionable = targets.find((item) => isActionableClassification(item.classification));
    if (actionable) {
      note(`[watchdog] ${actionable.job.id} → ${actionable.classification}; exiting.`);
      emitWatchEvent(buildWatchEvent(actionable));
      return 0;
    }

    if (firstPoll) {
      note(`[watchdog] ${targets.length} job(s) running; waiting…`);
      firstPoll = false;
    }

    const waited = Date.now() - startedAtMs;
    if (waited >= maxWaitMs) {
      emitWatchEvent({
        event: "watch-timeout",
        waitedMs: waited,
        maxWaitMs,
        jobs: targets.map((item) => item.view)
      });
      return 0;
    }

    const remaining = maxWaitMs === Infinity ? pollMs : Math.max(1, Math.min(pollMs, maxWaitMs - waited));
    await sleep(remaining);
  }
}

/* ------------------------------------------------------------------- reap */

const REAP_MARKER = "Reaped by codex-watchdog";

function writeJsonFile(filePath, payload) {
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function reapPatch(job, nowIso) {
  return {
    status: "failed",
    phase: "failed",
    pid: null,
    completedAt: nowIso,
    errorMessage: `${REAP_MARKER}: worker process ${job.pid ?? "unknown"} not alive.`
  };
}

function commandReap(flags, positional) {
  const { config, workspaceRoot, stateDirs } = resolveContext(flags);
  const targetId = positional[0] ?? null;
  const dryRun = flags.dryRun === true;
  const all = classifyAll(stateDirs, config);
  const nowIso = new Date().toISOString();

  const reaped = [];
  const skipped = [];

  for (const item of all) {
    if (targetId && item.job.id !== targetId) continue;
    if (!isDeadClassification(item.classification)) {
      if (targetId) {
        skipped.push({
          id: item.job.id,
          classification: item.classification,
          reason: "not-dead",
          evidence: item.evidence
        });
      }
      continue;
    }

    const patch = reapPatch(item.job, nowIso);
    const record = {
      id: item.job.id,
      stateDir: item.job.stateDir,
      previousStatus: item.job.status ?? null,
      previousPhase: item.job.phase ?? null,
      pid: item.job.pid ?? null,
      classification: item.classification,
      patch,
      filesUpdated: []
    };

    if (!dryRun) {
      const stateDir = item.job.stateDir;
      const stateFile = resolveStateFile(stateDir);
      const state = readStateFile(stateDir);
      const nextJobs = state.jobs.map((entry) =>
        entry && entry.id === item.job.id ? { ...entry, ...patch, updatedAt: nowIso } : entry
      );
      writeJsonFile(stateFile, { ...state.raw, jobs: nextJobs });
      record.filesUpdated.push(stateFile);

      const jobFile = resolveJobFile(stateDir, item.job.id);
      if (fs.existsSync(jobFile)) {
        try {
          const stored = JSON.parse(fs.readFileSync(jobFile, "utf8"));
          writeJsonFile(jobFile, { ...stored, ...patch });
          record.filesUpdated.push(jobFile);
        } catch (error) {
          record.jobFileError = error.message;
        }
      }
    }

    reaped.push(record);
  }

  if (targetId && reaped.length === 0 && skipped.length === 0) {
    skipped.push({ id: targetId, reason: "job-not-found" });
  }

  writeJson({
    command: "reap",
    generatedAt: nowIso,
    dryRun,
    workspaceRoot,
    stateDirs,
    reaped,
    skipped
  });

  note(`[watchdog] ${dryRun ? "would reap" : "reaped"} ${reaped.length} job(s).`);
  for (const record of reaped) {
    note(`[watchdog]   ${record.id} (pid ${record.pid ?? "?"}) ${record.previousStatus} → failed`);
  }
  for (const record of skipped) {
    note(`[watchdog]   skipped ${record.id}: ${record.reason}`);
  }
  return 0;
}

/* --------------------------------------------------------------- dispatch */

const DISPATCH_WITHOUT_BYPASS_MESSAGE = [
  "codex-watchdog: `dispatch` requires --bypass.",
  "",
  "This command is not a general dispatcher. For normal Codex work use the official",
  "openai-codex plugin (/codex:rescue, or its codex-companion.mjs task command) — it",
  "handles threads, results, cancellation and review gates.",
  "",
  "`dispatch --bypass` exists for one reason only: the official plugin hard-overrides",
  "the Codex sandbox (read-only / workspace-write + approvalPolicy \"never\"), so jobs",
  "that genuinely need network access or files outside the workspace fail silently.",
  "Re-run with --bypass if that is your situation."
].join("\n");

function readStdinSync() {
  try {
    if (process.stdin.isTTY) return "";
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function commandDispatch(flags, positional) {
  const homeDir = flags.homeDir && flags.homeDir !== true ? String(flags.homeDir) : os.homedir();
  const cwd = flags.cwd && flags.cwd !== true ? path.resolve(String(flags.cwd)) : process.cwd();
  const config = loadConfig({}, { homeDir });

  if (flags.bypass !== true) {
    process.stderr.write(`${DISPATCH_WITHOUT_BYPASS_MESSAGE}\n`);
    return 1;
  }

  if (config.allowBypassDispatch !== true) {
    process.stderr.write(
      "codex-watchdog: bypass dispatch is disabled by config " +
        `(allowBypassDispatch: false in ${config.configPath}).\n`
    );
    return 1;
  }

  const prompt = positional.join(" ").trim() || readStdinSync().trim();
  const model = flags.model && flags.model !== true ? String(flags.model) : null;
  const effort = flags.effort && flags.effort !== true ? String(flags.effort) : null;

  const job = createBypassJob({ cwd, prompt, model, effort, homeDir });

  const child = spawnDetachedBypassWorker({
    scriptPath: fileURLToPath(import.meta.url),
    stateDir: job.stateDir,
    jobId: job.id,
    cwd: job.request.cwd,
    env: process.env
  });
  updateBypassJob(job.stateDir, job.id, { pid: child.pid ?? null });

  writeJson({
    jobId: job.id,
    status: "queued",
    stateDir: job.stateDir,
    logFile: job.logFile,
    bypass: true
  });

  note(`[watchdog] bypass job ${job.id} queued (sandbox: danger-full-access).`);
  note(`[watchdog] log: ${job.logFile}`);
  note(`[watchdog] now open a watcher: watchdog.mjs watch ${job.id} --cwd ${job.request.cwd}`);
  return 0;
}

async function commandDispatchWorker(flags) {
  const stateDir = flags.stateDir && flags.stateDir !== true ? String(flags.stateDir) : null;
  const jobId = flags.jobId && flags.jobId !== true ? String(flags.jobId) : null;
  if (!stateDir || !jobId) {
    throw new Error("codex-watchdog: dispatch-worker requires --state-dir and --job-id.");
  }
  const outcome = await runBypassWorker({ stateDir, jobId, env: process.env });
  return outcome.status === "completed" ? 0 : 1;
}

/* ----------------------------------------------------------------- doctor */

function commandDoctor(flags) {
  const cwd = flags.cwd && flags.cwd !== true ? path.resolve(String(flags.cwd)) : process.cwd();
  const homeDir = flags.homeDir && flags.homeDir !== true ? String(flags.homeDir) : os.homedir();
  const config = loadConfig({}, { homeDir });

  const report = {
    command: "doctor",
    generatedAt: new Date().toISOString(),
    node: process.version,
    nodeOk: Number.parseInt(process.versions.node.split(".")[0], 10) >= 22,
    cwd,
    workspaceRoot: null,
    stateDirs: [],
    configPath: config.configPath,
    configFileFound: config.configFileFound,
    thresholds: {
      pollMs: config.pollMs,
      stallMs: config.stallMs,
      hardTimeoutMs: config.hardTimeoutMs
    },
    errors: []
  };

  let located = null;
  try {
    located = resolveCodexStateDirs(cwd, {
      stateDir: flags.stateDir && flags.stateDir !== true ? String(flags.stateDir) : null,
      homeDir
    });
    report.workspaceRoot = located.workspaceRoot;
  } catch (error) {
    report.errors.push(error.message);
  }

  for (const stateDir of located?.stateDirs ?? []) {
    const entry = { stateDir, version: null, jobCount: 0, activeCount: 0, zombieCount: 0, error: null };
    try {
      const state = readStateFile(stateDir);
      entry.version = state.version;
      const items = classifyAll([stateDir], config);
      entry.jobCount = items.length;
      entry.activeCount = items.filter((item) => !isTerminalStatus(item.job.status)).length;
      entry.zombieCount = items.filter((item) => isDeadClassification(item.classification)).length;
    } catch (error) {
      entry.error = error.message;
      report.errors.push(error.message);
    }
    report.stateDirs.push(entry);
  }

  writeJson(report);

  note(`[watchdog] node ${process.version} (${report.nodeOk ? "ok" : "TOO OLD — need >= 22"})`);
  note(`[watchdog] workspace: ${report.workspaceRoot ?? "(unresolved)"}`);
  for (const entry of report.stateDirs) {
    note(
      `[watchdog] ${entry.stateDir}: version=${entry.version} jobs=${entry.jobCount} ` +
        `active=${entry.activeCount} zombies=${entry.zombieCount}${entry.error ? ` ERROR: ${entry.error}` : ""}`
    );
  }
  for (const message of report.errors) note(`[watchdog] error: ${message}`);
  return report.errors.length ? 1 : 0;
}

/* -------------------------------------------------------------------- main */

export async function main(argv = process.argv.slice(2)) {
  const { flags, positional } = parseArgs(argv);
  const command = positional.shift();

  if (!command || flags.help || command === "help") {
    process.stderr.write(USAGE);
    return command ? 0 : 1;
  }

  switch (command) {
    case "check":
      return commandCheck(flags);
    case "watch":
      return await commandWatch(flags, positional);
    case "reap":
      return commandReap(flags, positional);
    case "doctor":
      return commandDoctor(flags);
    case "dispatch":
      return commandDispatch(flags, positional);
    case "dispatch-worker":
      return await commandDispatchWorker(flags);
    default:
      process.stderr.write(`codex-watchdog: unknown command "${command}".\n\n${USAGE}`);
      return 1;
  }
}

function safeRealpath(candidate) {
  try {
    return fs.realpathSync(candidate);
  } catch {
    return candidate;
  }
}

const invokedDirectly =
  Boolean(process.argv[1]) && safeRealpath(process.argv[1]) === safeRealpath(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  main()
    .then((code) => {
      process.exitCode = code ?? 0;
    })
    .catch((error) => {
      process.stderr.write(`codex-watchdog: ${error?.message ?? error}\n`);
      process.exitCode = 1;
    });
}
