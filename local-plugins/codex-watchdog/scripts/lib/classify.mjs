/**
 * codex-watchdog — classification.
 *
 * `classify` is a pure function: every filesystem / process probe is injected
 * via the `probe` argument so the rules are trivially testable.
 */

export const TERMINAL_STATUSES = Object.freeze(["completed", "failed", "cancelled"]);
export const ACTIVE_STATUSES = Object.freeze(["queued", "running"]);
export const DEAD_CLASSIFICATIONS = Object.freeze(["dead", "queued-dead"]);
export const KNOWN_EFFORTS = Object.freeze(["low", "medium", "high", "xhigh"]);

export function isTerminalStatus(status) {
  return TERMINAL_STATUSES.includes(status);
}

export function isActiveStatus(status) {
  return ACTIVE_STATUSES.includes(status);
}

export function isDeadClassification(classification) {
  return DEAD_CLASSIFICATIONS.includes(classification);
}

/**
 * Actionable = a state that should wake Claude up. `running` is the only
 * classification that means "keep waiting".
 */
export function isActionableClassification(classification) {
  return classification !== "running";
}

export function parseTimestampMs(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || value.trim() === "") return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

export function resolveEffortTier(job) {
  const effort = job?.request?.effort;
  if (typeof effort === "string") {
    const normalized = effort.trim().toLowerCase();
    if (KNOWN_EFFORTS.includes(normalized)) return normalized;
  }
  return "default";
}

/**
 * @param {object} job    merged job record (state.json entry + job file)
 * @param {object} probe  { pidAlive: boolean, logMtimeMs: number|null }
 * @param {object} config resolved config from config.mjs
 * @param {number} nowMs  epoch ms
 * @returns {{classification: string, evidence: object}}
 */
export function classify(job, probe = {}, config, nowMs = Date.now()) {
  if (!config || !config.stallMs || !Number.isFinite(config.hardTimeoutMs)) {
    throw new Error("codex-watchdog: classify() requires a resolved config (see config.mjs loadConfig()).");
  }

  const status = typeof job?.status === "string" ? job.status : null;
  const pid = Number.isInteger(job?.pid) && job.pid > 0 ? job.pid : null;
  const pidAlive = pid === null ? false : probe.pidAlive === true;

  const createdAtMs = parseTimestampMs(job?.createdAt);
  const startedAtMs = parseTimestampMs(job?.startedAt);
  const elapsedRefMs = startedAtMs ?? createdAtMs;
  const elapsedSource = startedAtMs !== null ? "startedAt" : createdAtMs !== null ? "createdAt" : "none";
  const elapsedMs = elapsedRefMs === null ? 0 : Math.max(0, nowMs - elapsedRefMs);

  const logMtimeMs = Number.isFinite(probe.logMtimeMs) ? probe.logMtimeMs : null;
  const logRefMs = logMtimeMs ?? createdAtMs;
  const logAgeSource = logMtimeMs !== null ? "logMtime" : createdAtMs !== null ? "createdAt" : "none";
  const logAgeMs = logRefMs === null ? 0 : Math.max(0, nowMs - logRefMs);

  const effortTier = resolveEffortTier(job);
  const stallThresholdMs = config.stallMs[effortTier] ?? config.stallMs.default;
  const hardTimeoutMs = config.hardTimeoutMs;

  const evidence = {
    status,
    pid,
    pidAlive,
    logFile: typeof job?.logFile === "string" ? job.logFile : null,
    logMtimeMs,
    logAgeMs,
    logAgeSource,
    elapsedMs,
    elapsedSource,
    effortTier,
    effort: job?.request?.effort ?? null,
    stallThresholdMs,
    hardTimeoutMs,
    nowMs,
    timestampParseFailed: elapsedSource === "none"
  };

  // 1. Terminal states are reported as-is.
  if (isTerminalStatus(status)) {
    return { classification: status, evidence };
  }

  // 2. Anything we do not recognise as active.
  if (!isActiveStatus(status)) {
    return { classification: "unknown", evidence };
  }

  // 3. Active but the worker process is gone.
  if (pid === null || !pidAlive) {
    return { classification: status === "queued" ? "queued-dead" : "dead", evidence };
  }

  // 4. Hard timeout.
  if (elapsedMs > hardTimeoutMs) {
    return { classification: "timed-out", evidence };
  }

  // 5. No log progress for longer than the effort-tiered stall threshold.
  if (logAgeMs > stallThresholdMs) {
    return { classification: "stalled", evidence };
  }

  // 6. Genuinely running.
  return { classification: "running", evidence };
}
