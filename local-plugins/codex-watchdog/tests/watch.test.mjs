import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test, { after } from "node:test";

import {
  cleanupAll,
  createStateDir,
  iso,
  makeJob,
  patchStateJson,
  setLogAge,
  spawnCli
} from "./fixtures/state-fixture.mjs";

after(cleanupAll);

const survivors = new Set();

after(() => {
  for (const child of survivors) {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
});

/** Spawn a real long-lived process we can use as a job's worker pid. */
async function spawnWorker() {
  const child = spawn("sleep", ["300"], { stdio: "ignore" });
  survivors.add(child);
  await new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  return child;
}

async function killWorker(child) {
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGKILL");
  await exited;
  survivors.delete(child);
}

function waitForStderr(handle, pattern, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tick = setInterval(() => {
      if (pattern.test(handle.stderr)) {
        clearInterval(tick);
        resolve();
      } else if (Date.now() > deadline) {
        clearInterval(tick);
        reject(new Error(`timed out waiting for ${pattern} in stderr:\n${handle.stderr}`));
      }
    }, 25);
  });
}

function singleEvent(result) {
  const lines = result.stdout.trim().split("\n").filter(Boolean);
  assert.equal(lines.length, 1, `watch must emit exactly one stdout line, got:\n${result.stdout}`);
  return JSON.parse(lines[0]);
}

test("AC4 — killing a real worker process makes watch exit with event:dead", async () => {
  const worker = await spawnWorker();
  const { stateDir } = createStateDir([makeJob({ id: "task-real", pid: worker.pid, threadId: "thread-abc" })]);

  const handle = spawnCli(["watch", "task-real", "--state-dir", stateDir, "--poll-ms", "150"]);
  await waitForStderr(handle, /job\(s\) running; waiting/);

  const startedAt = Date.now();
  await killWorker(worker);

  const result = await handle.done;
  const elapsed = Date.now() - startedAt;

  assert.equal(result.code, 0);
  const event = singleEvent(result);
  assert.equal(event.event, "dead");
  assert.equal(event.classification, "dead");
  assert.equal(event.jobId, "task-real");
  assert.equal(event.evidence.pidAlive, false);
  assert.equal(event.evidence.pid, worker.pid);
  assert.equal(event.resumeHint.threadId, "thread-abc");
  assert.ok(elapsed < 2_000, `should react within two polls, took ${elapsed}ms`);
});

test("AC5 — a job going terminal makes watch exit with event:completed", async () => {
  const worker = await spawnWorker();
  const { stateDir, stateFile } = createStateDir([
    makeJob({ id: "task-finish", pid: worker.pid, threadId: "thread-fin" })
  ]);

  const handle = spawnCli(["watch", "task-finish", "--state-dir", stateDir, "--poll-ms", "150"]);
  await waitForStderr(handle, /job\(s\) running; waiting/);

  patchStateJson(stateFile, "task-finish", {
    status: "completed",
    phase: "done",
    pid: null,
    summary: "all done",
    completedAt: iso()
  });

  const result = await handle.done;
  await killWorker(worker);

  const event = singleEvent(result);
  assert.equal(event.event, "completed");
  assert.equal(event.jobId, "task-finish");
  assert.equal(event.summary, "all done");
  assert.equal(event.threadId, "thread-fin");
});

test("watch reports a failed job with its error message", async () => {
  const worker = await spawnWorker();
  const { stateDir, stateFile } = createStateDir([makeJob({ id: "task-fail", pid: worker.pid })]);

  const handle = spawnCli(["watch", "task-fail", "--state-dir", stateDir, "--poll-ms", "150"]);
  await waitForStderr(handle, /job\(s\) running; waiting/);
  patchStateJson(stateFile, "task-fail", {
    status: "failed",
    phase: "failed",
    pid: null,
    errorMessage: "codex exploded"
  });

  const event = singleEvent(await handle.done);
  await killWorker(worker);
  assert.equal(event.event, "failed");
  assert.equal(event.errorMessage, "codex exploded");
});

test("AC6 — a job past the hard timeout exits with event:timed-out", async () => {
  const worker = await spawnWorker();
  const { stateDir } = createStateDir([
    makeJob({ id: "task-slow", pid: worker.pid, createdAt: iso(-7_200_000), startedAt: iso(-7_200_000) })
  ]);

  const handle = spawnCli([
    "watch",
    "task-slow",
    "--state-dir",
    stateDir,
    "--poll-ms",
    "100",
    "--hard-timeout-ms",
    "1000"
  ]);
  const result = await handle.done;
  await killWorker(worker);

  const event = singleEvent(result);
  assert.equal(event.event, "timed-out");
  assert.equal(event.evidence.hardTimeoutMs, 1000);
  assert.ok(event.evidence.elapsedMs > 1000);
});

test("a stalled job exits with event:stalled and the last log lines", async () => {
  const worker = await spawnWorker();
  const fixture = createStateDir([
    makeJob({ id: "task-stall", pid: worker.pid, createdAt: iso(-600_000), startedAt: iso(-600_000) })
  ]);
  setLogAge(fixture.jobs[0].logFile, 60_000);

  const handle = spawnCli([
    "watch",
    "task-stall",
    "--state-dir",
    fixture.stateDir,
    "--poll-ms",
    "100",
    "--stall-ms",
    "1000"
  ]);
  const result = await handle.done;
  await killWorker(worker);

  const event = singleEvent(result);
  assert.equal(event.event, "stalled");
  assert.equal(event.evidence.stallThresholdMs, 1000);
  assert.ok(Array.isArray(event.logTail));
  assert.ok(event.logTail.length >= 1, "stalled events carry log context for Claude to judge");
  assert.match(event.logTail.at(-1), /Starting/);
});

test("--max-wait-ms exits with event:watch-timeout while the job is still healthy", async () => {
  const worker = await spawnWorker();
  const { stateDir } = createStateDir([makeJob({ id: "task-patient", pid: worker.pid })]);

  const handle = spawnCli([
    "watch",
    "task-patient",
    "--state-dir",
    stateDir,
    "--poll-ms",
    "100",
    "--max-wait-ms",
    "400"
  ]);
  const result = await handle.done;
  await killWorker(worker);

  const event = singleEvent(result);
  assert.equal(event.event, "watch-timeout");
  assert.equal(event.maxWaitMs, 400);
  assert.equal(event.jobs[0].classification, "running");
});

test("no active jobs → nothing-to-watch", async () => {
  const { stateDir } = createStateDir([
    makeJob({ id: "task-done", status: "completed", phase: "done", pid: null, completedAt: iso(-1000) })
  ]);
  const result = await spawnCli(["watch", "--state-dir", stateDir, "--poll-ms", "100"]).done;
  const event = singleEvent(result);
  assert.equal(event.event, "nothing-to-watch");
  assert.equal(event.reason, "no-active-jobs");
});

test("an unknown job id → nothing-to-watch with job-not-found", async () => {
  const { stateDir } = createStateDir([makeJob({ id: "task-live", pid: process.pid })]);
  const result = await spawnCli(["watch", "task-nope", "--state-dir", stateDir, "--poll-ms", "100"]).done;
  const event = singleEvent(result);
  assert.equal(event.event, "nothing-to-watch");
  assert.equal(event.reason, "job-not-found");
});

test("watch with no job id follows every active job in the workspace", async () => {
  const workerA = await spawnWorker();
  const workerB = await spawnWorker();
  const { stateDir } = createStateDir([
    makeJob({ id: "task-a", pid: workerA.pid }),
    makeJob({ id: "task-b", pid: workerB.pid }),
    makeJob({ id: "task-old", status: "completed", phase: "done", pid: null })
  ]);

  const handle = spawnCli(["watch", "--state-dir", stateDir, "--poll-ms", "150"]);
  await waitForStderr(handle, /2 job\(s\) running; waiting/);
  await killWorker(workerB);

  const result = await handle.done;
  await killWorker(workerA);

  const event = singleEvent(result);
  assert.equal(event.event, "dead");
  assert.equal(event.jobId, "task-b");
});

test("a bad state format makes watch exit non-zero with no event JSON", async () => {
  const { stateDir } = createStateDir([makeJob({ id: "task-x", pid: process.pid })], { version: 42 });
  const result = await spawnCli(["watch", "task-x", "--state-dir", stateDir, "--poll-ms", "100"]).done;
  assert.notEqual(result.code, 0);
  assert.equal(result.stdout.trim(), "");
  assert.match(result.stderr, /unsupported codex state format version 42/);
});
