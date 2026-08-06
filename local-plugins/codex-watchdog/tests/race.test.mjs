/**
 * Regression tests for the five concurrency / correctness findings raised by
 * the 2026-08-06 adversarial review.
 *
 * Each test reproduces the specific interleaving the finding describes; the
 * `hooks.beforeWrite` seam used by the reap tests fires inside the
 * read → write window of the compare-and-swap, which is exactly where the
 * lost-update and stale-verdict races live.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test, { after } from "node:test";

import { loadConfig } from "../scripts/lib/config.mjs";
import { classify } from "../scripts/lib/classify.mjs";
import {
  PID_START_TOLERANCE_MS,
  loadJobs,
  mergeJobRecord,
  probeJob,
  readProcessStartMs,
  verifyPidIdentity
} from "../scripts/lib/state-locator.mjs";
import { updateJsonFileAtomic, writeJsonFileAtomic } from "../scripts/lib/json-store.mjs";
import { reapJobs } from "../scripts/lib/reap.mjs";
import {
  createBypassJob,
  setBypassJobPidIfQueued,
  updateBypassJob
} from "../scripts/lib/bypass-dispatch.mjs";
import {
  cleanupAll,
  createStateDir,
  iso,
  makeJob,
  makeTempDir,
  parseCliJson,
  readJobJson,
  readStateJson,
  runCli
} from "./fixtures/state-fixture.mjs";

after(cleanupAll);

function testConfig() {
  return loadConfig({}, { homeDir: makeTempDir("codex-watchdog-home-") });
}

function writeJobFileRaw(stateDir, jobId, record) {
  fs.writeFileSync(
    path.join(stateDir, "jobs", `${jobId}.json`),
    `${JSON.stringify(record, null, 2)}\n`,
    "utf8"
  );
}

function classifyItems(stateDir, config) {
  return loadJobs(stateDir).map((job) => {
    const probe = probeJob(job);
    const { classification, evidence } = classify(job, probe, config, Date.now());
    return { job, classification, evidence };
  });
}

/* ------------------------------------------------------------ finding 1 */

test("finding 1 — a job file that finished after the state snapshot wins the merge", () => {
  const { stateDir } = createStateDir([
    makeJob({ id: "task-toctou", pid: 999_999, status: "running", phase: "running" })
  ]);
  // The official worker writes jobs/<id>.json BEFORE state.json (verified in
  // tracked-jobs.mjs runTrackedJob), so this is what watchdog sees mid-flight.
  writeJobFileRaw(stateDir, "task-toctou", {
    ...readJobJson(stateDir, "task-toctou"),
    status: "completed",
    phase: "done",
    pid: null,
    completedAt: iso(-500),
    updatedAt: iso(-500)
  });

  const [job] = loadJobs(stateDir);
  assert.equal(job.status, "completed", "the terminal job file must beat the stale state entry");
  assert.equal(job.phase, "done");
  assert.equal(job.pid, null);
  assert.equal(job.statusSource, "jobFile");
});

test("finding 1 — a terminal state entry still wins over an active job file", () => {
  const { stateDir, stateFile } = createStateDir([
    makeJob({ id: "task-rev", pid: 999_999, status: "running" })
  ]);
  const state = readStateJson(stateFile);
  state.jobs[0] = { ...state.jobs[0], status: "completed", phase: "done", pid: null, completedAt: iso(-100) };
  fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");

  const [job] = loadJobs(stateDir);
  assert.equal(job.status, "completed");
  assert.equal(job.statusSource, "state");
});

test("finding 1 — mergeJobRecord keeps state fields when neither side is terminal", () => {
  const entry = { id: "j", status: "running", pid: 10, updatedAt: iso(-1000), summary: "from-state" };
  const jobFile = { id: "j", status: "queued", pid: null, updatedAt: iso(-5000), request: { effort: "high" } };
  const merged = mergeJobRecord(entry, jobFile, "/tmp/x");
  assert.equal(merged.status, "running");
  assert.equal(merged.pid, 10);
  assert.equal(merged.request.effort, "high", "non-status fields still come from the job file");
  assert.equal(merged.statusSource, "state");
});

test("finding 1 — check no longer calls a finished job dead", async () => {
  const { stateDir } = createStateDir([
    makeJob({ id: "task-finished", pid: 999_999, status: "running", phase: "running" })
  ]);
  writeJobFileRaw(stateDir, "task-finished", {
    ...readJobJson(stateDir, "task-finished"),
    status: "completed",
    phase: "done",
    pid: null,
    completedAt: iso(-500),
    updatedAt: iso(-500)
  });

  const payload = parseCliJson(await runCli(["check", "--state-dir", stateDir]));
  assert.equal(payload.jobs[0].classification, "completed");
});

/* ------------------------------------------------------------ finding 2 */

test("finding 2 — reap re-verifies inside the write window and skips a recovered job", () => {
  const { stateDir, stateFile } = createStateDir([
    makeJob({ id: "task-recovers", pid: 999_999, status: "running", phase: "running" })
  ]);
  const config = testConfig();
  const items = classifyItems(stateDir, config);
  assert.equal(items[0].classification, "dead", "precondition: it looks dead at classification time");

  const outcome = reapJobs({
    items,
    config,
    nowIso: new Date().toISOString(),
    hooks: {
      // The official worker completes the job while reap is between its read
      // and its write.
      beforeWrite() {
        const state = readStateJson(stateFile);
        state.jobs[0] = { ...state.jobs[0], status: "completed", phase: "done", pid: null, completedAt: iso() };
        fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
        writeJobFileRaw(stateDir, "task-recovers", {
          ...readJobJson(stateDir, "task-recovers"),
          status: "completed",
          phase: "done",
          pid: null,
          completedAt: iso()
        });
      }
    }
  });

  assert.equal(outcome.reaped.length, 0, "a job that finished must never be overwritten with failed");
  assert.equal(outcome.skipped.length, 1);
  assert.equal(outcome.skipped[0].reason, "recovered");
  assert.equal(outcome.skipped[0].classification, "completed");
  assert.equal(readStateJson(stateFile).jobs[0].status, "completed");
  assert.equal(readJobJson(stateDir, "task-recovers").status, "completed");
});

test("finding 2 — a job that is still dead is reaped normally", () => {
  const { stateDir, stateFile } = createStateDir([makeJob({ id: "task-still-dead", pid: 999_999 })]);
  const config = testConfig();
  const outcome = reapJobs({
    items: classifyItems(stateDir, config),
    config,
    nowIso: new Date().toISOString()
  });
  assert.equal(outcome.reaped.length, 1);
  assert.equal(readStateJson(stateFile).jobs[0].status, "failed");
  assert.equal(readJobJson(stateDir, "task-still-dead").status, "failed");
});

test("finding 2 — reap refuses to write if the state format changed under it", () => {
  const { stateDir, stateFile } = createStateDir([makeJob({ id: "task-fmt", pid: 999_999 })]);
  const config = testConfig();
  const outcome = reapJobs({
    items: classifyItems(stateDir, config),
    config,
    nowIso: new Date().toISOString(),
    hooks: {
      beforeWrite() {
        const state = readStateJson(stateFile);
        if (state.version === 2) return;
        fs.writeFileSync(stateFile, `${JSON.stringify({ ...state, version: 2 }, null, 2)}\n`, "utf8");
      }
    }
  });
  assert.equal(outcome.reaped.length, 0);
  assert.equal(outcome.skipped[0].reason, "state-format-changed");
  assert.equal(readStateJson(stateFile).jobs[0].status, "running");
});

/* ------------------------------------------------------------ finding 3 */

test("finding 3 — reap does not clobber a job added during its write window", () => {
  const { stateDir, stateFile } = createStateDir([makeJob({ id: "task-dead", pid: 999_999 })]);
  const config = testConfig();
  const outcome = reapJobs({
    items: classifyItems(stateDir, config),
    config,
    nowIso: new Date().toISOString(),
    hooks: {
      beforeWrite() {
        const state = readStateJson(stateFile);
        if (state.jobs.some((job) => job.id === "task-brand-new")) return;
        state.jobs.unshift(makeJob({ id: "task-brand-new", pid: process.pid }));
        fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
      }
    }
  });

  assert.equal(outcome.reaped.length, 1);
  const state = readStateJson(stateFile);
  assert.ok(
    state.jobs.find((job) => job.id === "task-brand-new"),
    "a job the official plugin added mid-write must survive"
  );
  assert.equal(state.jobs.find((job) => job.id === "task-dead").status, "failed");
});

test("finding 3 — updateJsonFileAtomic retries on a concurrent write instead of losing it", () => {
  const dir = makeTempDir();
  const file = path.join(dir, "state.json");
  writeJsonFileAtomic(file, { version: 1, jobs: [{ id: "a" }] });

  let attempts = 0;
  const result = updateJsonFileAtomic(
    file,
    (state) => {
      attempts += 1;
      return { ...state, jobs: [...state.jobs, { id: "mine" }] };
    },
    {
      onAfterRead() {
        if (attempts > 1) return;
        const current = JSON.parse(fs.readFileSync(file, "utf8"));
        current.jobs.push({ id: "theirs" });
        fs.writeFileSync(file, `${JSON.stringify(current, null, 2)}\n`, "utf8");
      }
    }
  );

  assert.equal(result.written, true);
  assert.equal(attempts, 2, "the first attempt must be discarded and replayed");
  const ids = JSON.parse(fs.readFileSync(file, "utf8")).jobs.map((job) => job.id);
  assert.deepEqual(ids, ["a", "theirs", "mine"]);
});

test("finding 3 — writes are rename-based and leave no temp files behind", () => {
  const dir = makeTempDir();
  const file = path.join(dir, "state.json");
  writeJsonFileAtomic(file, { version: 1, jobs: [] });
  updateJsonFileAtomic(file, (state) => ({ ...state, jobs: [{ id: "x" }] }));
  assert.deepEqual(fs.readdirSync(dir), ["state.json"]);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).jobs[0].id, "x");
});

test("finding 3 — a mutator can abort without touching the file", () => {
  const dir = makeTempDir();
  const file = path.join(dir, "state.json");
  writeJsonFileAtomic(file, { version: 1, jobs: [{ id: "a" }] });
  const before = fs.readFileSync(file, "utf8");
  const result = updateJsonFileAtomic(file, () => ({ abort: true, reason: "recovered" }));
  assert.equal(result.written, false);
  assert.equal(result.reason, "recovered");
  assert.equal(fs.readFileSync(file, "utf8"), before);
});

/* ------------------------------------------------------------ finding 4 */

test("finding 4 — process start time is readable and older than now", () => {
  const startMs = readProcessStartMs(process.pid);
  if (startMs === null) return; // platform without a usable `ps` — degrade covered below
  assert.ok(startMs <= Date.now() + 1000);
  assert.ok(startMs > Date.now() - 7 * 24 * 3600_000, "our own process did not start a week ago");
});

test("finding 4 — a recycled pid (long-lived process, young job) counts as dead", () => {
  const startMs = readProcessStartMs(1);
  if (startMs === null || Date.now() - startMs < PID_START_TOLERANCE_MS) return; // cannot prove reuse here
  const job = { pid: 1, status: "running", startedAt: iso(-1000), createdAt: iso(-1000) };
  const probe = probeJob(job);
  assert.equal(probe.pidAlive, true, "pid 1 exists (EPERM counts as alive)");
  assert.equal(probe.pidIdentityVerified, true);
  assert.equal(probe.pidReuseSuspected, true);

  const { classification, evidence } = classify(job, probe, testConfig(), Date.now());
  assert.equal(classification, "dead");
  assert.equal(evidence.pidReuseSuspected, true);
  assert.equal(evidence.pidRawAlive, true);
});

test("finding 4 — a genuine worker pid is not flagged", () => {
  const job = { pid: process.pid, status: "running", startedAt: iso(-60_000), createdAt: iso(-60_000) };
  const probe = probeJob(job);
  assert.equal(probe.pidReuseSuspected, false);
  assert.equal(classify(job, probe, testConfig(), Date.now()).classification, "running");
});

test("finding 4 — unavailable process start time degrades gracefully", () => {
  const identity = verifyPidIdentity(1234, Date.now(), { processStartMs: null });
  assert.equal(identity.pidIdentityVerified, false);
  assert.equal(identity.pidReuseSuspected, false);

  const noTimestamps = probeJob({ pid: process.pid, status: "running" });
  assert.equal(noTimestamps.pidAlive, true);
  assert.equal(noTimestamps.pidIdentityVerified, false);
  assert.equal(noTimestamps.pidReuseSuspected, false);
});

test("finding 4 — process start times are cached briefly, then re-read", () => {
  const cache = new Map();
  const first = readProcessStartMs(process.pid, { cache, nowMs: 1_000 });
  cache.set(process.pid, { value: 42, readAtMs: 1_000 });
  assert.equal(readProcessStartMs(process.pid, { cache, nowMs: 1_100 }), 42, "served from cache");
  const refreshed = readProcessStartMs(process.pid, { cache, nowMs: 1_000 + 60_000 });
  assert.equal(refreshed, first, "an expired entry is re-read from ps");
});

test("finding 4 — check reports a recycled pid as dead and says why", async () => {
  const startMs = readProcessStartMs(1);
  if (startMs === null || Date.now() - startMs < PID_START_TOLERANCE_MS) return;
  const { stateDir } = createStateDir([
    makeJob({ id: "task-recycled", pid: 1, status: "running", startedAt: iso(-1000), createdAt: iso(-1000) })
  ]);
  const payload = parseCliJson(await runCli(["check", "--state-dir", stateDir]));
  assert.equal(payload.jobs[0].classification, "dead");
  assert.equal(payload.jobs[0].evidence.pidReuseSuspected, true);
  assert.equal(payload.jobs[0].evidence.pidIdentityVerified, true);
});

/* ------------------------------------------------------------ finding 5 */

test("finding 5 — the parent never resurrects a bypass job the worker already finished", () => {
  const homeDir = makeTempDir("codex-watchdog-home-");
  const cwd = makeTempDir("codex-watchdog-ws-");
  const job = createBypassJob({ cwd, prompt: "do the thing", homeDir });

  // The detached worker wins the race and completes before the parent writes pid.
  updateBypassJob(job.stateDir, job.id, {
    status: "completed",
    phase: "done",
    pid: null,
    completedAt: iso(),
    summary: "done"
  });

  const outcome = setBypassJobPidIfQueued(job.stateDir, job.id, 4242);
  assert.equal(outcome.applied, false);
  assert.equal(outcome.status, "completed");

  const state = readStateJson(path.join(job.stateDir, "state.json"));
  const entry = state.jobs.find((item) => item.id === job.id);
  assert.equal(entry.status, "completed", "status must not fall back to queued");
  assert.equal(entry.pid, null, "a dead pid must not be re-attached");
  assert.equal(readJobJson(job.stateDir, job.id).status, "completed");
});

test("finding 5 — the pid is still recorded while the job is queued", () => {
  const homeDir = makeTempDir("codex-watchdog-home-");
  const cwd = makeTempDir("codex-watchdog-ws-");
  const job = createBypassJob({ cwd, prompt: "do the thing", homeDir });

  const outcome = setBypassJobPidIfQueued(job.stateDir, job.id, 4242);
  assert.equal(outcome.applied, true);

  const entry = readStateJson(path.join(job.stateDir, "state.json")).jobs.find((item) => item.id === job.id);
  assert.equal(entry.pid, 4242);
  assert.equal(entry.status, "queued");
  assert.equal(readJobJson(job.stateDir, job.id).pid, 4242);
});
