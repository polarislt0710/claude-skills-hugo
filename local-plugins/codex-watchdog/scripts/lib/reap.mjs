/**
 * codex-watchdog — reap.
 *
 * Reaping is the only destructive thing this plugin does: it rewrites somebody
 * else's job record. Two rules make that safe:
 *
 *   1. NEVER write on a stale verdict. The classification that selected a job
 *      is minutes-to-milliseconds old by the time we write. The official worker
 *      may have completed the job in between, and overwriting a `completed`
 *      job with `failed` destroys a real result. So the dead verdict is
 *      re-computed from freshly read bytes + a fresh pid probe *inside* the
 *      compare-and-swap mutator, on every attempt.
 *   2. NEVER lose somebody else's write. All writes go through
 *      json-store.mjs (temp file + rename, plus CAS retry), so a job the
 *      official plugin appended while we were thinking survives.
 */
import fs from "node:fs";

import { classify, isDeadClassification } from "./classify.mjs";
import { updateJsonFileAtomic, writeJsonFileAtomic } from "./json-store.mjs";
import {
  SUPPORTED_STATE_VERSION,
  mergeJobRecord,
  probeJob,
  readJobFile,
  resolveJobFile,
  resolveStateFile
} from "./state-locator.mjs";

export const REAP_MARKER = "Reaped by codex-watchdog";

export function reapPatch(job, nowIso) {
  return {
    status: "failed",
    phase: "failed",
    pid: null,
    completedAt: nowIso,
    errorMessage: `${REAP_MARKER}: worker process ${job.pid ?? "unknown"} not alive.`
  };
}

/**
 * Re-derive the verdict from the state entries we just read off disk.
 * @returns {{dead: boolean, reason?: string, classification?: string, evidence?: object, job?: object}}
 */
function reverifyDead(stateEntries, stateDir, jobId, config) {
  const entry = Array.isArray(stateEntries) ? stateEntries.find((item) => item && item.id === jobId) : null;
  if (!entry) return { dead: false, reason: "job-record-disappeared" };

  const job = mergeJobRecord(entry, readJobFile(stateDir, jobId), stateDir);
  const probe = probeJob(job);
  const { classification, evidence } = classify(job, probe, config, Date.now());
  if (!isDeadClassification(classification)) {
    return { dead: false, reason: "recovered", classification, evidence, job };
  }
  return { dead: true, classification, evidence, job };
}

/**
 * Reap one job. Returns either a reaped record or a skip reason.
 */
export function reapJob(item, config, nowIso, hooks = {}) {
  const stateDir = item.job.stateDir;
  const jobId = item.job.id;
  const stateFile = resolveStateFile(stateDir);
  const record = {
    id: jobId,
    stateDir,
    previousStatus: item.job.status ?? null,
    previousPhase: item.job.phase ?? null,
    pid: item.job.pid ?? null,
    classification: item.classification,
    patch: reapPatch(item.job, nowIso),
    filesUpdated: []
  };

  let verdict = null;
  const outcome = updateJsonFileAtomic(
    stateFile,
    (state) => {
      // The version guard also applies to the bytes we are about to overwrite,
      // not just to the ones we classified from.
      if (state?.version !== SUPPORTED_STATE_VERSION) {
        return { abort: true, reason: "state-format-changed", detail: { version: state?.version ?? null } };
      }
      verdict = reverifyDead(state.jobs, stateDir, jobId, config);
      if (!verdict.dead) {
        return { abort: true, reason: verdict.reason, detail: verdict };
      }
      // Re-derive the patch from the freshly read record so the recorded pid
      // is the one we actually just probed.
      record.previousStatus = verdict.job.status ?? null;
      record.previousPhase = verdict.job.phase ?? null;
      record.pid = verdict.job.pid ?? null;
      record.classification = verdict.classification;
      record.patch = reapPatch(verdict.job, nowIso);
      return {
        ...state,
        jobs: state.jobs.map((entry) =>
          entry && entry.id === jobId ? { ...entry, ...record.patch, updatedAt: nowIso } : entry
        )
      };
    },
    { onAfterRead: hooks.beforeWrite ? () => hooks.beforeWrite(jobId, stateDir) : null }
  );

  if (!outcome.written) {
    return {
      skipped: {
        id: jobId,
        reason: outcome.reason,
        classification: verdict?.classification ?? null,
        evidence: verdict?.evidence ?? null
      }
    };
  }
  record.filesUpdated.push(stateFile);
  record.casAttempts = outcome.attempts;

  const jobFile = resolveJobFile(stateDir, jobId);
  if (fs.existsSync(jobFile)) {
    try {
      const stored = JSON.parse(fs.readFileSync(jobFile, "utf8"));
      writeJsonFileAtomic(jobFile, { ...stored, ...record.patch });
      record.filesUpdated.push(jobFile);
    } catch (error) {
      record.jobFileError = error.message;
    }
  }

  return { reaped: record };
}

/**
 * @param {object[]} items    classified items ({ job, classification, evidence })
 * @param {object}   config   resolved config
 * @param {string?}  targetId reap only this job id
 * @param {boolean}  dryRun   report without writing
 * @param {string}   nowIso   timestamp stamped into the patch
 * @param {object}   hooks    { beforeWrite } — test seam firing inside the CAS window
 */
export function reapJobs({ items, config, targetId = null, dryRun = false, nowIso, hooks = {} }) {
  const reaped = [];
  const skipped = [];

  for (const item of items) {
    if (targetId && item.job.id !== targetId) continue;

    if (!isDeadClassification(item.classification)) {
      if (targetId) {
        skipped.push({
          id: item.job.id,
          classification: item.classification,
          reason: "not-dead",
          evidence: item.evidence
        });
      }
      continue;
    }

    if (dryRun) {
      reaped.push({
        id: item.job.id,
        stateDir: item.job.stateDir,
        previousStatus: item.job.status ?? null,
        previousPhase: item.job.phase ?? null,
        pid: item.job.pid ?? null,
        classification: item.classification,
        patch: reapPatch(item.job, nowIso),
        filesUpdated: []
      });
      continue;
    }

    const result = reapJob(item, config, nowIso, hooks);
    if (result.reaped) reaped.push(result.reaped);
    else skipped.push(result.skipped);
  }

  if (targetId && reaped.length === 0 && skipped.length === 0) {
    skipped.push({ id: targetId, reason: "job-not-found" });
  }

  return { reaped, skipped };
}
