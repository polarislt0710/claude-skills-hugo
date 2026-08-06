import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test, { after } from "node:test";

import {
  candidateStateRoots,
  computeStateDirName,
  isPidAlive,
  loadJobs,
  probeJob,
  readLogTail,
  readStateFile,
  resolveCodexStateDirs
} from "../scripts/lib/state-locator.mjs";
import { cleanupAll, createStateDir, makeJob, makeTempDir } from "./fixtures/state-fixture.mjs";

after(cleanupAll);

test("state dir name matches the official slug-hash algorithm", () => {
  const workspaceRoot = makeTempDir("codex watchdog ws ");
  const canonical = fs.realpathSync.native(workspaceRoot);
  const base = path.basename(workspaceRoot);
  const expectedSlug = base.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  const expectedHash = createHash("sha256").update(canonical).digest("hex").slice(0, 16);
  assert.equal(computeStateDirName(workspaceRoot), `${expectedSlug}-${expectedHash}`);
});

test("slug sanitisation falls back to 'workspace' when nothing survives", () => {
  assert.match(computeStateDirName("/"), /^workspace-[0-9a-f]{16}$/);
});

test("AC10 — no state dir found throws and mentions --state-dir", () => {
  const homeDir = makeTempDir("codex-watchdog-home-");
  const tmpDir = makeTempDir("codex-watchdog-tmp-");
  const cwd = makeTempDir("codex-watchdog-ws-");
  assert.throws(
    () => resolveCodexStateDirs(cwd, { homeDir, tmpDir }),
    (error) => {
      assert.match(error.message, /--state-dir/);
      assert.match(error.message, /no codex-companion state directory found/);
      return true;
    }
  );
});

test("an explicit --state-dir that does not exist throws", () => {
  assert.throws(
    () => resolveCodexStateDirs(process.cwd(), { stateDir: "/definitely/not/here" }),
    /does not exist/
  );
});

test("explicit --state-dir short-circuits discovery", () => {
  const { stateDir } = createStateDir([makeJob()]);
  const result = resolveCodexStateDirs(process.cwd(), { stateDir });
  assert.deepEqual(result.stateDirs, [path.resolve(stateDir)]);
});

test("discovery scans every plugin data namespace plus the tmp fallback", () => {
  const homeDir = makeTempDir("codex-watchdog-home-");
  const tmpDir = makeTempDir("codex-watchdog-tmp-");
  const workspaceRoot = makeTempDir("codex-watchdog-ws-");
  const dirName = computeStateDirName(workspaceRoot);

  const nsA = path.join(homeDir, ".claude", "plugins", "data", "codex-inline", "state");
  const nsB = path.join(homeDir, ".claude", "plugins", "data", "other-ns", "state");
  const fallback = path.join(tmpDir, "codex-companion");
  for (const root of [nsA, nsB, fallback]) fs.mkdirSync(path.join(root, dirName), { recursive: true });
  // A namespace without a matching workspace dir must be ignored.
  fs.mkdirSync(path.join(homeDir, ".claude", "plugins", "data", "empty-ns", "state"), { recursive: true });

  const roots = candidateStateRoots({ homeDir, tmpDir });
  assert.equal(roots.length, 4);

  const { stateDirs } = resolveCodexStateDirs(workspaceRoot, { homeDir, tmpDir, workspaceRoot });
  assert.equal(stateDirs.length, 3);
  assert.ok(stateDirs.includes(path.join(nsA, dirName)));
  assert.ok(stateDirs.includes(path.join(nsB, dirName)));
  assert.ok(stateDirs.includes(path.join(fallback, dirName)));
});

test("AC8 — state.json with an unsupported version throws a clear error", () => {
  const { stateDir } = createStateDir([makeJob()], { version: 2 });
  assert.throws(
    () => readStateFile(stateDir),
    (error) => {
      assert.match(error.message, /unsupported codex state format version 2/);
      assert.match(error.message, /version 1/);
      return true;
    }
  );
});

test("state.json that is missing or malformed throws rather than defaulting", () => {
  const { stateDir, stateFile } = createStateDir([makeJob()]);
  fs.writeFileSync(stateFile, "{ broken", "utf8");
  assert.throws(() => readStateFile(stateDir), /not valid JSON/);

  fs.rmSync(stateFile);
  assert.throws(() => readStateFile(stateDir), /cannot read/);
});

test("loadJobs merges the job file (request/effort) into the state entry", () => {
  const { stateDir } = createStateDir([
    makeJob({ id: "task-a", request: { effort: "xhigh", model: "gpt-5.6-sol" } })
  ]);
  const jobs = loadJobs(stateDir);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].id, "task-a");
  assert.equal(jobs[0].request.effort, "xhigh", "request only exists in the job file");
  assert.equal(jobs[0].status, "running");
  assert.equal(jobs[0].stateDir, stateDir);
});

test("loadJobs survives a job file that is missing or corrupt", () => {
  const { stateDir } = createStateDir([makeJob({ id: "task-b" })]);
  fs.writeFileSync(path.join(stateDir, "jobs", "task-b.json"), "nope", "utf8");
  const jobs = loadJobs(stateDir);
  assert.equal(jobs[0].id, "task-b");
  assert.equal(jobs[0].request, undefined);
});

test("isPidAlive: ESRCH means dead, our own pid means alive, pid 1 (EPERM-ish) means alive", async () => {
  assert.equal(isPidAlive(process.pid), true);
  assert.equal(isPidAlive(1), true, "pid 1 exists — EPERM must count as alive");
  assert.equal(isPidAlive(0), false);
  assert.equal(isPidAlive(-5), false);
  assert.equal(isPidAlive(null), false);

  const child = spawn("sleep", ["300"], { stdio: "ignore" });
  await new Promise((resolve) => child.once("spawn", resolve));
  assert.equal(isPidAlive(child.pid), true);
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGKILL");
  await exited;
  assert.equal(isPidAlive(child.pid), false, "ESRCH after the process is reaped");
});

test("probeJob reports pid liveness and log mtime together", () => {
  const { stateDir, jobs } = createStateDir([makeJob({ id: "task-c", pid: process.pid })]);
  const [job] = loadJobs(stateDir);
  const probe = probeJob(job);
  assert.equal(probe.pidAlive, true);
  assert.ok(probe.logMtimeMs > 0);
  assert.ok(fs.existsSync(jobs[0].logFile));

  const noLog = probeJob({ pid: process.pid, logFile: "/no/such/log" });
  assert.equal(noLog.logMtimeMs, null);
});

test("readLogTail returns the last N non-empty lines", () => {
  const dir = makeTempDir();
  const logFile = path.join(dir, "job.log");
  fs.writeFileSync(logFile, ["a", "b", "", "c", "d", "e", "f", ""].join("\n"), "utf8");
  assert.deepEqual(readLogTail(logFile, 5), ["b", "c", "d", "e", "f"]);
  assert.deepEqual(readLogTail("/no/such/log", 5), []);
});
