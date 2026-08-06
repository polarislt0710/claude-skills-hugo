import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test, { after } from "node:test";

import { loadConfig } from "../scripts/lib/config.mjs";
import { buildCodexArgs, resolveCodexBinary } from "../scripts/lib/bypass-dispatch.mjs";
import {
  cleanupAll,
  createStateDir,
  iso,
  makeFakeCodex,
  makeJob,
  makeTempDir,
  parseCliJson,
  runCli,
  waitFor
} from "./fixtures/state-fixture.mjs";

after(cleanupAll);

function readJobRecord(stateDir, jobId) {
  return JSON.parse(fs.readFileSync(path.join(stateDir, "jobs", `${jobId}.json`), "utf8"));
}

async function waitForTerminal(stateDir, jobId) {
  return waitFor(() => {
    let record;
    try {
      record = readJobRecord(stateDir, jobId);
    } catch {
      return null;
    }
    return ["completed", "failed", "cancelled"].includes(record.status) ? record : null;
  });
}

/* ------------------------------------------------------- deny annotation */

test("check annotates a failed job whose log shows a sandbox denial", async () => {
  const fixture = createStateDir([
    makeJob({
      id: "task-denied",
      status: "failed",
      phase: "failed",
      pid: null,
      completedAt: iso(-1000),
      errorMessage: "codex exec exited with code 1"
    })
  ]);
  fs.appendFileSync(
    fixture.jobs[0].logFile,
    `[${iso()}] curl: (7) Network is unreachable\n[${iso()}] sandbox denied write to /etc/hosts\n`,
    "utf8"
  );

  const payload = parseCliJson(await runCli(["check", "--state-dir", fixture.stateDir]));
  const job = payload.jobs.find((entry) => entry.id === "task-denied");
  assert.equal(job.classification, "failed", "classification must be untouched by the deny scan");
  assert.equal(job.evidence.sandboxDeny.suspected, true);
  assert.deepEqual(
    job.evidence.sandboxDeny.matches.map((match) => match.pattern),
    ["network-unreachable", "sandbox"]
  );
});

test("a clean failed job is not flagged as a sandbox denial", async () => {
  const fixture = createStateDir([
    makeJob({ id: "task-clean-fail", status: "failed", phase: "failed", pid: null, completedAt: iso(-1000) })
  ]);
  const payload = parseCliJson(await runCli(["check", "--state-dir", fixture.stateDir]));
  const job = payload.jobs.find((entry) => entry.id === "task-clean-fail");
  assert.equal(job.evidence.sandboxDeny.suspected, false);
});

test("watch carries sandboxDeny on a dead-job event", async () => {
  const fixture = createStateDir([
    makeJob({ id: "task-dead-denied", pid: 999_999, status: "running" })
  ]);
  fs.appendFileSync(fixture.jobs[0].logFile, `[${iso()}] EACCES: permission denied, open '/etc/hosts'\n`, "utf8");

  const payload = parseCliJson(await runCli(["watch", "task-dead-denied", "--state-dir", fixture.stateDir]));
  assert.equal(payload.event, "dead");
  assert.equal(payload.sandboxDeny.suspected, true);
  assert.equal(payload.sandboxDeny.matches[0].pattern, "eacces");
});

/* ---------------------------------------------------------------- guards */

test("dispatch without --bypass errors and points at the official plugin", async () => {
  const result = await runCli(["dispatch", "do something"]);
  assert.equal(result.code, 1);
  assert.equal(result.stdout, "", "no job may be created without --bypass");
  assert.match(result.stderr, /requires --bypass/);
  assert.match(result.stderr, /codex:rescue/);
});

test("allowBypassDispatch:false blocks dispatch --bypass", async () => {
  const homeDir = makeTempDir("codex-watchdog-home-");
  fs.writeFileSync(path.join(homeDir, ".codex-watchdog.json"), JSON.stringify({ allowBypassDispatch: false }), "utf8");
  const config = loadConfig({}, { homeDir });
  assert.equal(config.allowBypassDispatch, false);

  const result = await runCli(["dispatch", "--bypass", "do something"], { homeDir });
  assert.equal(result.code, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /bypass dispatch is disabled by config/);
});

test("allowBypassDispatch defaults to true and rejects non-booleans", () => {
  const homeDir = makeTempDir("codex-watchdog-home-");
  assert.equal(loadConfig({}, { homeDir }).allowBypassDispatch, true);
  fs.writeFileSync(path.join(homeDir, ".codex-watchdog.json"), JSON.stringify({ allowBypassDispatch: "no" }), "utf8");
  assert.throws(() => loadConfig({}, { homeDir }), /allowBypassDispatch must be a boolean/);
});

test("dispatch --bypass with no prompt fails loudly", async () => {
  const workspace = makeTempDir("codex-watchdog-ws-");
  const result = await runCli(["dispatch", "--bypass", "--cwd", workspace]);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /requires a prompt/);
});

/* -------------------------------------------------------- codex resolution */

test("resolveCodexBinary finds codex on PATH and fails loud when it is absent", () => {
  const fake = makeFakeCodex();
  assert.equal(resolveCodexBinary({ PATH: fake.dir }), fake.binary);
  assert.throws(() => resolveCodexBinary({ PATH: makeTempDir("codex-watchdog-empty-") }), /not found on PATH/);
});

test("buildCodexArgs always forces danger-full-access and maps model/effort", () => {
  assert.deepEqual(buildCodexArgs(), ["exec", "--sandbox", "danger-full-access", "--skip-git-repo-check"]);
  assert.deepEqual(buildCodexArgs({ model: "gpt-5.6-sol", effort: "high" }), [
    "exec",
    "--sandbox",
    "danger-full-access",
    "--skip-git-repo-check",
    "--model",
    "gpt-5.6-sol",
    "-c",
    "model_reasoning_effort=high"
  ]);
});

/* ------------------------------------------------------- full worker cycle */

test("dispatch --bypass runs the detached worker to completion with a fake codex", async () => {
  const workspace = makeTempDir("codex-watchdog-ws-");
  const homeDir = makeTempDir("codex-watchdog-home-");
  const argsFile = path.join(makeTempDir("codex-watchdog-args-"), "argv.txt");
  const fake = makeFakeCodex({ stdout: "BYPASS OK: fetched the remote file", argsFile });

  const result = await runCli(
    ["dispatch", "--bypass", "--cwd", workspace, "--model", "gpt-5.6-sol", "--effort", "high", "fetch the thing"],
    { homeDir, env: fake.env }
  );
  assert.equal(result.code, 0);

  const dispatched = parseCliJson(result);
  assert.equal(dispatched.status, "queued");
  assert.equal(dispatched.bypass, true);
  assert.match(dispatched.jobId, /^bypass-/);
  assert.ok(dispatched.stateDir.includes(path.join(".claude", "plugins", "data", "codex-watchdog", "state")));
  assert.match(result.stderr, /watch/);

  const record = await waitForTerminal(dispatched.stateDir, dispatched.jobId);
  assert.equal(record.status, "completed");
  assert.equal(record.phase, "done");
  assert.equal(record.pid, null);
  assert.match(record.result.rawOutput, /BYPASS OK/);

  const argv = fs.readFileSync(argsFile, "utf8").trim().split("\n");
  assert.deepEqual(argv, [
    "exec",
    "--sandbox",
    "danger-full-access",
    "--skip-git-repo-check",
    "--model",
    "gpt-5.6-sol",
    "-c",
    "model_reasoning_effort=high",
    "fetch the thing"
  ]);

  const log = fs.readFileSync(dispatched.logFile, "utf8");
  assert.match(log, /^\[\d{4}-\d{2}-\d{2}T[\d:.]+Z\] /m, "log lines keep the official [ISO] prefix");
  assert.match(log, /BYPASS OK/);

  // Watchdog's own log lines must not trip its own deny scanner.
  const checked = parseCliJson(await runCli(["check", "--state-dir", dispatched.stateDir], { homeDir }));
  const scanned = checked.jobs.find((entry) => entry.id === dispatched.jobId);
  assert.equal(scanned.evidence.sandboxDeny.suspected, false, "a clean bypass job must not self-flag");
});

test("a failing fake codex marks the bypass job failed with the exit code and stderr tail", async () => {
  const workspace = makeTempDir("codex-watchdog-ws-");
  const homeDir = makeTempDir("codex-watchdog-home-");
  const fake = makeFakeCodex({ exitCode: 1, stdout: "partial work", stderr: "boom: sandbox denied network access" });

  const dispatched = parseCliJson(
    await runCli(["dispatch", "--bypass", "--cwd", workspace, "break things"], { homeDir, env: fake.env })
  );
  const record = await waitForTerminal(dispatched.stateDir, dispatched.jobId);

  assert.equal(record.status, "failed");
  assert.equal(record.phase, "failed");
  assert.match(record.errorMessage, /exited with code 1/);
  assert.match(record.errorMessage, /sandbox denied network access/);
  assert.match(record.result.rawOutput, /partial work/);
});

test("bypass jobs are discovered by the existing check command across namespaces", async () => {
  const workspace = makeTempDir("codex-watchdog-ws-");
  const homeDir = makeTempDir("codex-watchdog-home-");
  const fake = makeFakeCodex({ stdout: "done" });

  const dispatched = parseCliJson(
    await runCli(["dispatch", "--bypass", "--cwd", workspace, "hello"], { homeDir, env: fake.env })
  );
  await waitForTerminal(dispatched.stateDir, dispatched.jobId);

  // No --state-dir: this exercises the real locator walking
  // <home>/.claude/plugins/data/*/state/<slug>-<hash>.
  const payload = parseCliJson(await runCli(["check", "--cwd", workspace], { homeDir }));
  assert.deepEqual(payload.stateDirs, [dispatched.stateDir]);
  const job = payload.jobs.find((entry) => entry.id === dispatched.jobId);
  assert.ok(job, "the bypass job must be visible to check without --state-dir");
  assert.equal(job.classification, "completed");
  assert.equal(job.kind, "bypass-task");
});
