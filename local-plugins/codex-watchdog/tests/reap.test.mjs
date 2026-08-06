import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  cleanupAll,
  createStateDir,
  iso,
  makeJob,
  parseCliJson,
  readJobJson,
  readStateJson,
  runCli
} from "./fixtures/state-fixture.mjs";

after(cleanupAll);

test("AC7 — reap marks dead jobs failed in both state.json and the job file", async () => {
  const { stateDir, stateFile } = createStateDir([
    makeJob({ id: "task-zombie", pid: 999_999, status: "running", phase: "running" }),
    makeJob({ id: "task-live", pid: process.pid })
  ]);

  const result = await runCli(["reap", "--state-dir", stateDir]);
  assert.equal(result.code, 0);
  const payload = parseCliJson(result);
  assert.equal(payload.dryRun, false);
  assert.equal(payload.reaped.length, 1);
  assert.equal(payload.reaped[0].id, "task-zombie");
  assert.equal(payload.reaped[0].previousStatus, "running");

  const state = readStateJson(stateFile);
  assert.equal(state.version, 1, "version and config survive the rewrite");
  assert.equal(state.config.stopReviewGate, false);

  const zombie = state.jobs.find((job) => job.id === "task-zombie");
  assert.equal(zombie.status, "failed");
  assert.equal(zombie.phase, "failed");
  assert.equal(zombie.pid, null);
  assert.ok(zombie.completedAt);
  assert.match(zombie.errorMessage, /codex-watchdog/);
  assert.match(zombie.errorMessage, /999999/);

  const jobFile = readJobJson(stateDir, "task-zombie");
  assert.equal(jobFile.status, "failed");
  assert.equal(jobFile.phase, "failed");
  assert.equal(jobFile.pid, null);
  assert.match(jobFile.errorMessage, /codex-watchdog/);

  const live = state.jobs.find((job) => job.id === "task-live");
  assert.equal(live.status, "running", "healthy jobs are untouched");
});

test("AC7 — after reap the job is no longer active, so official status stops lying", async () => {
  const { stateDir, stateFile } = createStateDir([makeJob({ id: "task-zombie", pid: 999_999 })]);
  await runCli(["reap", "--state-dir", stateDir]);

  const activeAfter = readStateJson(stateFile).jobs.filter((job) =>
    ["queued", "running"].includes(job.status)
  );
  assert.equal(activeAfter.length, 0);

  const recheck = parseCliJson(await runCli(["check", "--state-dir", stateDir]));
  assert.equal(recheck.jobs[0].classification, "failed");
});

test("--dry-run reports without writing", async () => {
  const { stateDir, stateFile } = createStateDir([makeJob({ id: "task-zombie", pid: 999_999 })]);
  const before = readStateJson(stateFile);

  const payload = parseCliJson(await runCli(["reap", "--state-dir", stateDir, "--dry-run"]));
  assert.equal(payload.dryRun, true);
  assert.equal(payload.reaped.length, 1);
  assert.deepEqual(payload.reaped[0].filesUpdated, []);

  assert.deepEqual(readStateJson(stateFile), before, "nothing on disk changed");
});

test("reap <job-id> only touches that job", async () => {
  const { stateDir, stateFile } = createStateDir([
    makeJob({ id: "task-zombie-a", pid: 999_998 }),
    makeJob({ id: "task-zombie-b", pid: 999_999 })
  ]);

  const payload = parseCliJson(await runCli(["reap", "task-zombie-a", "--state-dir", stateDir]));
  assert.equal(payload.reaped.length, 1);
  assert.equal(payload.reaped[0].id, "task-zombie-a");

  const state = readStateJson(stateFile);
  assert.equal(state.jobs.find((job) => job.id === "task-zombie-a").status, "failed");
  assert.equal(state.jobs.find((job) => job.id === "task-zombie-b").status, "running");
});

test("reap on a healthy job reports it as skipped, not reaped", async () => {
  const { stateDir } = createStateDir([makeJob({ id: "task-live", pid: process.pid })]);
  const payload = parseCliJson(await runCli(["reap", "task-live", "--state-dir", stateDir]));
  assert.equal(payload.reaped.length, 0);
  assert.equal(payload.skipped[0].reason, "not-dead");
  assert.equal(payload.skipped[0].classification, "running");
});

test("reap on an unknown job id reports job-not-found", async () => {
  const { stateDir } = createStateDir([makeJob({ id: "task-live", pid: process.pid })]);
  const payload = parseCliJson(await runCli(["reap", "task-nope", "--state-dir", stateDir]));
  assert.equal(payload.reaped.length, 0);
  assert.equal(payload.skipped[0].reason, "job-not-found");
});

test("reap also collects queued jobs whose worker never came up", async () => {
  const { stateDir, stateFile } = createStateDir([
    makeJob({ id: "task-queued", status: "queued", phase: "queued", pid: 999_997, startedAt: null, createdAt: iso(-5000) })
  ]);
  const payload = parseCliJson(await runCli(["reap", "--state-dir", stateDir]));
  assert.equal(payload.reaped[0].classification, "queued-dead");
  assert.equal(readStateJson(stateFile).jobs[0].status, "failed");
});
