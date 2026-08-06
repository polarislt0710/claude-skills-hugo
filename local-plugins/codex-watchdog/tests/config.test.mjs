import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test, { after } from "node:test";

import { DEFAULT_CONFIG, loadConfig, readConfigFile } from "../scripts/lib/config.mjs";
import { cleanupAll, makeTempDir } from "./fixtures/state-fixture.mjs";

after(cleanupAll);

function homeWith(contents) {
  const homeDir = makeTempDir("codex-watchdog-home-");
  if (contents !== undefined) {
    fs.writeFileSync(path.join(homeDir, ".codex-watchdog.json"), contents, "utf8");
  }
  return homeDir;
}

test("defaults apply when no config file exists", () => {
  const config = loadConfig({}, { homeDir: homeWith(undefined) });
  assert.equal(config.configFileFound, false);
  assert.equal(config.pollMs, DEFAULT_CONFIG.pollMs);
  assert.equal(config.hardTimeoutMs, 60 * 60_000);
  assert.equal(config.stallMs.low, 5 * 60_000);
  assert.equal(config.stallMs.medium, 5 * 60_000);
  assert.equal(config.stallMs.high, 10 * 60_000);
  assert.equal(config.stallMs.xhigh, 20 * 60_000);
  assert.equal(config.stallMs.default, 10 * 60_000);
});

test("config file overrides defaults", () => {
  const homeDir = homeWith(JSON.stringify({ pollMs: 1000, stallMinutes: { high: 2 }, hardTimeoutMinutes: 3 }));
  const config = loadConfig({}, { homeDir });
  assert.equal(config.configFileFound, true);
  assert.equal(config.pollMs, 1000);
  assert.equal(config.stallMs.high, 2 * 60_000);
  assert.equal(config.stallMs.low, 5 * 60_000, "untouched tiers keep defaults");
  assert.equal(config.hardTimeoutMs, 3 * 60_000);
});

test("CLI overrides beat the config file", () => {
  const homeDir = homeWith(JSON.stringify({ pollMs: 1000, hardTimeoutMinutes: 3 }));
  const config = loadConfig({ pollMs: 250, stallMs: 777, hardTimeoutMs: 999 }, { homeDir });
  assert.equal(config.pollMs, 250);
  assert.equal(config.hardTimeoutMs, 999);
  for (const tier of ["low", "medium", "high", "xhigh", "default"]) {
    assert.equal(config.stallMs[tier], 777, `${tier} tier flattened by --stall-ms`);
  }
});

test("malformed config file fails loud", () => {
  const homeDir = homeWith("{ not json");
  assert.throws(() => readConfigFile({ homeDir }), /not valid JSON/);
  assert.throws(() => loadConfig({}, { homeDir }), /not valid JSON/);
});

test("invalid threshold values are rejected", () => {
  assert.throws(
    () => loadConfig({}, { homeDir: homeWith(JSON.stringify({ pollMs: 0 })) }),
    /pollMs must be a positive number/
  );
  assert.throws(
    () => loadConfig({}, { homeDir: homeWith(JSON.stringify({ stallMinutes: { nope: 4 } })) }),
    /unknown effort tier/
  );
});

test("skipFile ignores the user config entirely", () => {
  const homeDir = homeWith(JSON.stringify({ pollMs: 1 }));
  const config = loadConfig({}, { homeDir, skipFile: true });
  assert.equal(config.pollMs, DEFAULT_CONFIG.pollMs);
});
