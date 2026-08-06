import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test, { after } from "node:test";

import { MAX_DENY_MATCHES, scanForSandboxDeny } from "../scripts/lib/deny-scan.mjs";
import { readLogTailBytes, scanJobForSandboxDeny } from "../scripts/lib/state-locator.mjs";
import { cleanupAll, makeTempDir } from "./fixtures/state-fixture.mjs";

after(cleanupAll);

test("scanForSandboxDeny finds nothing in a clean log", () => {
  const result = scanForSandboxDeny([
    "[2026-08-06T00:00:00.000Z] Starting Codex Task.",
    "[2026-08-06T00:00:01.000Z] Reading src/index.ts",
    "[2026-08-06T00:00:02.000Z] Done."
  ]);
  assert.equal(result.suspected, false);
  assert.deepEqual(result.matches, []);
});

test("scanForSandboxDeny matches every documented pattern, case-insensitively", () => {
  const cases = [
    ["Sandbox denied the write", "sandbox"],
    ["permission DENIED for /etc/hosts", "denied"],
    ["seatbelt will deny this call", "deny"],
    ["mkdir: not permitted", "not-permitted"],
    ["Error: Operation not permitted (os error 1)", "operation-not-permitted"],
    ["write failed: EPERM", "eperm"],
    ["open('/etc/passwd'): EACCES", "eacces"],
    ["touch: Read-only file system", "read-only-file-system"],
    ["curl: (7) Network is unreachable", "network-unreachable"],
    ["fetch failed: no network available", "no-network"],
    ["network access is disabled in this sandbox", "network-access"],
    ["command was blocked by policy", "blocked"],
    ["this command requires approval", "requires-approval"]
  ];
  for (const [line, expected] of cases) {
    const result = scanForSandboxDeny([line]);
    assert.equal(result.suspected, true, `expected a hit for: ${line}`);
    assert.equal(result.matches[0].pattern, expected, `wrong pattern name for: ${line}`);
    assert.equal(result.matches[0].line, line);
  }
});

test("scanForSandboxDeny caps matches at 5", () => {
  const lines = Array.from({ length: 20 }, (_, index) => `line ${index}: EACCES`);
  const result = scanForSandboxDeny(lines);
  assert.equal(result.matches.length, MAX_DENY_MATCHES);
  assert.equal(result.suspected, true);
});

test("scanForSandboxDeny accepts a raw string chunk and skips blank lines", () => {
  const result = scanForSandboxDeny("ok\n\n   \nEPERM while writing\n");
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].pattern, "eperm");
});

test("readLogTailBytes only reads the tail of a big log", () => {
  const dir = makeTempDir("codex-watchdog-log-");
  const logFile = path.join(dir, "big.log");
  const filler = `${"x".repeat(200)}\n`.repeat(3000); // ~600KB
  fs.writeFileSync(logFile, `${filler}sandbox denied at the very end\n`, "utf8");

  const lines = readLogTailBytes(logFile, 4096);
  assert.ok(lines.length > 0);
  assert.ok(lines.join("\n").length <= 4096);
  assert.equal(scanForSandboxDeny(lines).suspected, true);
});

test("readLogTailBytes tolerates a missing log; scanJobForSandboxDeny returns a clean result", () => {
  assert.deepEqual(readLogTailBytes("/tmp/codex-watchdog-does-not-exist.log"), []);
  assert.deepEqual(scanJobForSandboxDeny({ logFile: null }), { suspected: false, matches: [] });
});
