import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  cleanupAll,
  createStateDir,
  iso,
  makeJob,
  parseCliJson,
  runCli,
  setLogAge
} from "./fixtures/state-fixture.mjs";

after(cleanupAll);

test("AC1 — check classifies a zombie job as dead and prints JSON on stdout only", async () => {
  const { stateDir } = createStateDir([
    makeJob({ id: "task-zombie", pid: 999_999, status: "running", createdAt: iso(-600_000), startedAt: iso(-600_000) })
  ]);
  const result = await runCli(["check", "--state-dir", stateDir]);
  assert.equal(result.code, 0);

  const payload = parseCliJson(result);
  assert.equal(payload.command, "check");
  const job = payload.jobs.find((entry) => entry.id === "task-zombie");
  assert.equal(job.classification, "dead");
  assert.equal(job.evidence.pidAlive, false);
  assert.equal(payload.counts.dead, 1);

  // stdout is exactly one JSON object; the human summary lives on stderr.
  assert.equal(result.stdout.trim().split("\n").length, 1);
  assert.match(result.stderr, /\[watchdog\]/);
});

test("AC2 — a live pid with a fresh log is running", async () => {
  const { stateDir } = createStateDir([makeJob({ id: "task-live", pid: process.pid })]);
  const payload = parseCliJson(await runCli(["check", "--state-dir", stateDir]));
  assert.equal(payload.jobs[0].classification, "running");
});

test("AC3 — a stale log with a live pid is stalled with the right threshold", async () => {
  const fixture = createStateDir([
    makeJob({ id: "task-stall", pid: process.pid, request: { effort: "low" }, createdAt: iso(-600_000) })
  ]);
  setLogAge(fixture.jobs[0].logFile, 6 * 60_000);

  const payload = parseCliJson(await runCli(["check", "--state-dir", fixture.stateDir]));
  const job = payload.jobs[0];
  assert.equal(job.classification, "stalled");
  assert.equal(job.evidence.effortTier, "low");
  assert.equal(job.evidence.stallThresholdMs, 5 * 60_000);
});

test("--stall-ms override flips a running job to stalled", async () => {
  const fixture = createStateDir([makeJob({ id: "task-tight", pid: process.pid })]);
  setLogAge(fixture.jobs[0].logFile, 3_000);
  const payload = parseCliJson(await runCli(["check", "--state-dir", fixture.stateDir, "--stall-ms", "1000"]));
  assert.equal(payload.jobs[0].classification, "stalled");
  assert.equal(payload.jobs[0].evidence.stallThresholdMs, 1000);
});

test("AC8 — an unsupported state format version exits non-zero with a clear message", async () => {
  const { stateDir } = createStateDir([makeJob()], { version: 99 });
  const result = await runCli(["check", "--state-dir", stateDir]);
  assert.notEqual(result.code, 0);
  assert.equal(result.stdout.trim(), "", "no JSON is emitted when the format is unknown");
  assert.match(result.stderr, /unsupported codex state format version 99/);
});

test("AC10 — an unknown state dir exits non-zero and suggests --state-dir", async () => {
  const result = await runCli(["check", "--state-dir", "/tmp/codex-watchdog-nope-does-not-exist"]);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /does not exist/);
});

test("default check trims terminal jobs to the latest 10; --all shows everything", async () => {
  const jobs = [makeJob({ id: "task-active", pid: process.pid })];
  for (let index = 0; index < 15; index += 1) {
    jobs.push(
      makeJob({
        id: `task-done-${String(index).padStart(2, "0")}`,
        status: "completed",
        phase: "done",
        pid: null,
        completedAt: iso(-index * 1000),
        updatedAt: iso(-index * 1000)
      })
    );
  }
  const { stateDir } = createStateDir(jobs);

  const trimmed = parseCliJson(await runCli(["check", "--state-dir", stateDir]));
  assert.equal(trimmed.totalJobs, 16);
  assert.equal(trimmed.jobs.length, 11, "1 active + 10 most recent terminal");
  assert.equal(trimmed.truncated, true);
  assert.ok(trimmed.jobs.some((job) => job.id === "task-active"));

  const all = parseCliJson(await runCli(["check", "--state-dir", stateDir, "--all"]));
  assert.equal(all.jobs.length, 16);
  assert.equal(all.truncated, false);
});

test("doctor reports node version, format version and zombie count", async () => {
  const { stateDir } = createStateDir([
    makeJob({ id: "task-zombie", pid: 999_999 }),
    makeJob({ id: "task-live", pid: process.pid })
  ]);
  const result = await runCli(["doctor", "--state-dir", stateDir]);
  assert.equal(result.code, 0);
  const payload = parseCliJson(result);
  assert.equal(payload.command, "doctor");
  assert.equal(payload.nodeOk, true);
  assert.equal(payload.stateDirs[0].version, 1);
  assert.equal(payload.stateDirs[0].jobCount, 2);
  assert.equal(payload.stateDirs[0].zombieCount, 1);
  assert.equal(payload.thresholds.hardTimeoutMs, 60 * 60_000);
});

test("doctor surfaces a bad format version without crashing", async () => {
  const { stateDir } = createStateDir([makeJob()], { version: 7 });
  const result = await runCli(["doctor", "--state-dir", stateDir]);
  const payload = parseCliJson(result);
  assert.match(payload.stateDirs[0].error, /unsupported codex state format version 7/);
  assert.notEqual(result.code, 0);
});

test("an unknown subcommand exits 1 with usage on stderr", async () => {
  const result = await runCli(["frobnicate"]);
  assert.equal(result.code, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /unknown command "frobnicate"/);
});
