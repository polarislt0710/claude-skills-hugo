import assert from "node:assert/strict";
import test, { after } from "node:test";

import { loadConfig } from "../scripts/lib/config.mjs";
import { classify, resolveEffortTier } from "../scripts/lib/classify.mjs";
import { cleanupAll, makeJob, makeTempDir } from "./fixtures/state-fixture.mjs";

after(cleanupAll);

const CONFIG = loadConfig({}, { homeDir: makeTempDir("codex-watchdog-home-"), skipFile: true });
const NOW = Date.parse("2026-08-06T12:00:00.000Z");

function at(minutesAgo) {
  return new Date(NOW - minutesAgo * 60_000).toISOString();
}

/* ---------------------------------------------------------------- AC1 dead */

test("AC1 — status=running with a dead pid classifies as dead", () => {
  const job = makeJob({ status: "running", pid: 23748, createdAt: at(3), startedAt: at(3) });
  const { classification, evidence } = classify(job, { pidAlive: false, logMtimeMs: NOW - 1000 }, CONFIG, NOW);
  assert.equal(classification, "dead");
  assert.equal(evidence.pid, 23748);
  assert.equal(evidence.pidAlive, false);
});

test("a missing pid on an active job is also dead", () => {
  const job = makeJob({ status: "running", pid: null, createdAt: at(1), startedAt: at(1) });
  assert.equal(classify(job, { pidAlive: false, logMtimeMs: NOW }, CONFIG, NOW).classification, "dead");
});

test("queued job with a dead pid is queued-dead", () => {
  const job = makeJob({ status: "queued", pid: 4242, startedAt: null, createdAt: at(1) });
  assert.equal(classify(job, { pidAlive: false, logMtimeMs: NOW }, CONFIG, NOW).classification, "queued-dead");
});

/* ------------------------------------------------------------- AC2 running */

test("AC2 — live pid with a fresh log is running (no false positive)", () => {
  const job = makeJob({ status: "running", pid: 999, createdAt: at(2), startedAt: at(2) });
  const { classification, evidence } = classify(job, { pidAlive: true, logMtimeMs: NOW - 5_000 }, CONFIG, NOW);
  assert.equal(classification, "running");
  assert.equal(evidence.logAgeSource, "logMtime");
  assert.equal(evidence.logAgeMs, 5_000);
});

/* ------------------------------------------------------------- AC3 stalled */

test("AC3 — live pid with a stale log is stalled, tier default = 10 min", () => {
  const job = makeJob({ status: "running", pid: 999, request: null, createdAt: at(30), startedAt: at(30) });
  const { classification, evidence } = classify(
    job,
    { pidAlive: true, logMtimeMs: NOW - 11 * 60_000 },
    CONFIG,
    NOW
  );
  assert.equal(classification, "stalled");
  assert.equal(evidence.effortTier, "default");
  assert.equal(evidence.stallThresholdMs, 10 * 60_000);
});

test("AC3 — effort tiers pick their own stall threshold", () => {
  const cases = [
    ["low", 5 * 60_000],
    ["medium", 5 * 60_000],
    ["high", 10 * 60_000],
    ["xhigh", 20 * 60_000]
  ];
  for (const [effort, expected] of cases) {
    const job = makeJob({
      status: "running",
      pid: 999,
      request: { effort },
      createdAt: at(40),
      startedAt: at(40)
    });
    const stale = classify(job, { pidAlive: true, logMtimeMs: NOW - (expected + 1000) }, CONFIG, NOW);
    assert.equal(stale.classification, "stalled", `${effort} past threshold`);
    assert.equal(stale.evidence.stallThresholdMs, expected);
    assert.equal(stale.evidence.effortTier, effort);

    const fresh = classify(job, { pidAlive: true, logMtimeMs: NOW - (expected - 1000) }, CONFIG, NOW);
    assert.equal(fresh.classification, "running", `${effort} inside threshold`);
  }
});

test("an unknown effort value falls back to the default tier", () => {
  assert.equal(resolveEffortTier({ request: { effort: "ludicrous" } }), "default");
  assert.equal(resolveEffortTier({ request: null }), "default");
  assert.equal(resolveEffortTier({}), "default");
  assert.equal(resolveEffortTier({ request: { effort: "XHigh" } }), "xhigh");
});

test("a missing log file falls back to createdAt for log age", () => {
  const job = makeJob({ status: "running", pid: 999, createdAt: at(30), startedAt: at(30) });
  const { classification, evidence } = classify(job, { pidAlive: true, logMtimeMs: null }, CONFIG, NOW);
  assert.equal(classification, "stalled");
  assert.equal(evidence.logAgeSource, "createdAt");
  assert.equal(evidence.logAgeMs, 30 * 60_000);
});

/* ------------------------------------------------------------ AC6 timed-out */

test("AC6 — elapsed past the hard timeout wins over the stall rule", () => {
  const job = makeJob({ status: "running", pid: 999, createdAt: at(90), startedAt: at(90) });
  const { classification, evidence } = classify(job, { pidAlive: true, logMtimeMs: NOW - 1000 }, CONFIG, NOW);
  assert.equal(classification, "timed-out");
  assert.equal(evidence.elapsedMs, 90 * 60_000);
  assert.equal(evidence.hardTimeoutMs, 60 * 60_000);
});

test("dead beats timed-out — a dead worker is reported as dead", () => {
  const job = makeJob({ status: "running", pid: 999, createdAt: at(90), startedAt: at(90) });
  assert.equal(classify(job, { pidAlive: false, logMtimeMs: NOW }, CONFIG, NOW).classification, "dead");
});

/* ----------------------------------------------------------------- terminal */

test("terminal statuses are passed through untouched", () => {
  for (const status of ["completed", "failed", "cancelled"]) {
    const job = makeJob({ status, pid: null, completedAt: at(1) });
    assert.equal(classify(job, { pidAlive: false, logMtimeMs: null }, CONFIG, NOW).classification, status);
  }
});

test("unrecognised statuses classify as unknown", () => {
  const job = makeJob({ status: "sleepwalking", pid: 999 });
  assert.equal(classify(job, { pidAlive: true, logMtimeMs: NOW }, CONFIG, NOW).classification, "unknown");
  const noStatus = makeJob({ status: undefined, pid: 999 });
  assert.equal(classify(noStatus, { pidAlive: true, logMtimeMs: NOW }, CONFIG, NOW).classification, "unknown");
});

/* ------------------------------------------------------------------ purity */

test("classify is pure — same inputs, same output, no input mutation", () => {
  const job = makeJob({ status: "running", pid: 999, createdAt: at(2), startedAt: at(2) });
  const snapshot = JSON.stringify(job);
  const probe = { pidAlive: true, logMtimeMs: NOW - 1000 };
  const first = classify(job, probe, CONFIG, NOW);
  const second = classify(job, probe, CONFIG, NOW);
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(job), snapshot);
});

test("unparseable timestamps degrade to 0 and are flagged in evidence", () => {
  const job = makeJob({ status: "running", pid: 999, createdAt: "not-a-date", startedAt: "also-bad" });
  const { classification, evidence } = classify(job, { pidAlive: true, logMtimeMs: NOW }, CONFIG, NOW);
  assert.equal(classification, "running");
  assert.equal(evidence.elapsedMs, 0);
  assert.equal(evidence.timestampParseFailed, true);
});

test("classify refuses to run without a resolved config", () => {
  assert.throws(() => classify(makeJob(), {}, undefined, NOW), /requires a resolved config/);
});
