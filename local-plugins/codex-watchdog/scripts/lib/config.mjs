/**
 * codex-watchdog — configuration resolution.
 *
 * Precedence: CLI flags > ~/.codex-watchdog.json > built-in defaults.
 * Pure-ish: the only side effect is reading the config file, and the home
 * directory is injectable so tests never touch the real one.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const CONFIG_FILE_NAME = ".codex-watchdog.json";

export const EFFORT_TIERS = Object.freeze(["low", "medium", "high", "xhigh", "default"]);

export const DEFAULT_CONFIG = Object.freeze({
  pollMs: 30_000,
  stallMinutes: Object.freeze({
    low: 5,
    medium: 5,
    high: 10,
    xhigh: 20,
    default: 10
  }),
  hardTimeoutMinutes: 60,
  // `dispatch --bypass` is the only sandbox escape hatch; set false to disable it.
  allowBypassDispatch: true
});

const MINUTE_MS = 60_000;

function positiveNumber(value, label) {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    throw new Error(`codex-watchdog config: ${label} must be a positive number (got ${JSON.stringify(value)}).`);
  }
  return numeric;
}

export function resolveConfigPath({ homeDir = os.homedir() } = {}) {
  return path.join(homeDir, CONFIG_FILE_NAME);
}

/**
 * Read ~/.codex-watchdog.json. Missing file → {}. Malformed file → throw loud.
 */
export function readConfigFile({ homeDir = os.homedir() } = {}) {
  const configPath = resolveConfigPath({ homeDir });
  let raw;
  try {
    raw = fs.readFileSync(configPath, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return { config: {}, configPath, found: false };
    }
    throw new Error(`codex-watchdog: cannot read ${configPath}: ${error.message}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`codex-watchdog: ${configPath} is not valid JSON: ${error.message}`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`codex-watchdog: ${configPath} must contain a JSON object.`);
  }

  return { config: parsed, configPath, found: true };
}

/**
 * @param {object} overrides CLI overrides.
 *   pollMs, hardTimeoutMs, stallMs (applies to every tier),
 *   stallMinutes ({tier: minutes}), hardTimeoutMinutes.
 * @param {object} options { homeDir, skipFile }
 */
export function loadConfig(overrides = {}, options = {}) {
  const { homeDir = os.homedir(), skipFile = false } = options;

  const fileResult = skipFile
    ? { config: {}, configPath: resolveConfigPath({ homeDir }), found: false }
    : readConfigFile({ homeDir });
  const fileConfig = fileResult.config;

  const stallMinutes = { ...DEFAULT_CONFIG.stallMinutes };
  for (const source of [fileConfig.stallMinutes, overrides.stallMinutes]) {
    if (source == null) continue;
    if (typeof source !== "object" || Array.isArray(source)) {
      throw new Error("codex-watchdog config: stallMinutes must be an object keyed by effort tier.");
    }
    for (const [tier, value] of Object.entries(source)) {
      if (!EFFORT_TIERS.includes(tier)) {
        throw new Error(
          `codex-watchdog config: unknown effort tier "${tier}" (expected one of ${EFFORT_TIERS.join(", ")}).`
        );
      }
      stallMinutes[tier] = positiveNumber(value, `stallMinutes.${tier}`);
    }
  }

  let pollMs = positiveNumber(
    fileConfig.pollMs ?? DEFAULT_CONFIG.pollMs,
    "pollMs"
  );
  if (overrides.pollMs != null) {
    pollMs = positiveNumber(overrides.pollMs, "pollMs");
  }

  let hardTimeoutMinutes = positiveNumber(
    fileConfig.hardTimeoutMinutes ?? DEFAULT_CONFIG.hardTimeoutMinutes,
    "hardTimeoutMinutes"
  );
  if (overrides.hardTimeoutMinutes != null) {
    hardTimeoutMinutes = positiveNumber(overrides.hardTimeoutMinutes, "hardTimeoutMinutes");
  }

  let hardTimeoutMs = hardTimeoutMinutes * MINUTE_MS;
  if (fileConfig.hardTimeoutMs != null) {
    hardTimeoutMs = positiveNumber(fileConfig.hardTimeoutMs, "hardTimeoutMs");
  }
  if (overrides.hardTimeoutMs != null) {
    hardTimeoutMs = positiveNumber(overrides.hardTimeoutMs, "hardTimeoutMs");
  }

  const stallMs = {};
  for (const tier of EFFORT_TIERS) {
    stallMs[tier] = stallMinutes[tier] * MINUTE_MS;
  }
  if (fileConfig.stallMs != null) {
    const flat = positiveNumber(fileConfig.stallMs, "stallMs");
    for (const tier of EFFORT_TIERS) stallMs[tier] = flat;
  }
  if (overrides.stallMs != null) {
    const flat = positiveNumber(overrides.stallMs, "stallMs");
    for (const tier of EFFORT_TIERS) stallMs[tier] = flat;
  }

  let allowBypassDispatch = DEFAULT_CONFIG.allowBypassDispatch;
  for (const source of [fileConfig.allowBypassDispatch, overrides.allowBypassDispatch]) {
    if (source == null) continue;
    if (typeof source !== "boolean") {
      throw new Error(
        `codex-watchdog config: allowBypassDispatch must be a boolean (got ${JSON.stringify(source)}).`
      );
    }
    allowBypassDispatch = source;
  }

  return Object.freeze({
    pollMs,
    allowBypassDispatch,
    stallMinutes: Object.freeze(stallMinutes),
    hardTimeoutMinutes,
    hardTimeoutMs,
    stallMs: Object.freeze(stallMs),
    configPath: fileResult.configPath,
    configFileFound: fileResult.found
  });
}
