/**
 * codex-watchdog — crash-safe JSON file writes.
 *
 * WHY
 * The official codex-companion plugin rewrites `state.json` with a plain
 * `fs.writeFileSync`, i.e. truncate-then-write. Two things go wrong with that:
 *   1. a reader can observe a half-written file (measured: 72 unparseable
 *      reads out of 311 against a 1.4 MB file being rewritten in a loop);
 *   2. a writer that read the file a moment earlier silently discards whatever
 *      anybody else wrote in between (lost update).
 *
 * We cannot fix the official plugin's writes, but we can stop contributing to
 * the problem: every watchdog write goes through `writeJsonFileAtomic`
 * (tmp file + `rename`, which is atomic on POSIX for same-directory renames),
 * and every read-modify-write goes through `updateJsonFileAtomic`, which
 * re-reads the file immediately before the rename and replays the mutation if
 * the bytes changed under us (compare-and-swap with bounded retries).
 *
 * Pure Node — no lock libraries, no new dependencies.
 */
import fs from "node:fs";
import path from "node:path";

export const DEFAULT_CAS_RETRIES = 3;

function tempPathFor(filePath) {
  const random = Math.random().toString(36).slice(2, 10);
  return path.join(path.dirname(filePath), `.${path.basename(filePath)}.tmp-${process.pid}-${random}`);
}

/**
 * Serialize first, then write to a sibling temp file, then rename over the
 * target. A crash or a concurrent reader either sees the old file or the new
 * one — never a truncated one.
 */
export function writeJsonFileAtomic(filePath, payload) {
  const serialized = `${JSON.stringify(payload, null, 2)}\n`;
  const tempPath = tempPathFor(filePath);
  let handle = null;
  try {
    handle = fs.openSync(tempPath, "w");
    fs.writeFileSync(handle, serialized, "utf8");
    try {
      fs.fsyncSync(handle);
    } catch {
      /* fsync is best effort — some filesystems refuse it */
    }
    fs.closeSync(handle);
    handle = null;
    fs.renameSync(tempPath, filePath);
    return serialized;
  } catch (error) {
    if (handle !== null) {
      try {
        fs.closeSync(handle);
      } catch {
        /* ignore */
      }
    }
    try {
      fs.rmSync(tempPath, { force: true });
    } catch {
      /* ignore */
    }
    throw error;
  }
}

/**
 * Read-modify-write with compare-and-swap.
 *
 * `mutator(parsed, { attempt, raw })` returns either the next value, or
 * `{ abort: true, reason, ... }` to leave the file untouched. Returning an
 * abort is how callers re-verify their decision against freshly read bytes:
 * the mutator runs again on every retry, so it always sees current state.
 *
 * `onAfterRead` is a test seam that fires inside the read→write window.
 *
 * @returns {{written: boolean, attempts: number, value?: any, reason?: string, detail?: any}}
 */
export function updateJsonFileAtomic(filePath, mutator, options = {}) {
  const { retries = DEFAULT_CAS_RETRIES, onAfterRead = null } = options;
  let lastRaw = null;

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    const raw = fs.readFileSync(filePath, "utf8");
    lastRaw = raw;
    const parsed = JSON.parse(raw);
    const next = mutator(parsed, { attempt, raw });

    if (next && typeof next === "object" && next.abort === true) {
      return { written: false, attempts: attempt, reason: next.reason ?? "aborted", detail: next.detail ?? null };
    }

    onAfterRead?.({ attempt, filePath });

    let current;
    try {
      current = fs.readFileSync(filePath, "utf8");
    } catch (error) {
      throw new Error(`codex-watchdog: ${filePath} disappeared while updating it: ${error.message}`);
    }
    if (current !== raw) continue; // somebody else wrote — replay the mutation

    writeJsonFileAtomic(filePath, next);
    return { written: true, attempts: attempt, value: next };
  }

  throw new Error(
    `codex-watchdog: ${filePath} kept changing under us (${retries} attempts). ` +
      "Another process is writing it right now — re-run in a moment."
  );
}

export function readJsonFileOrNull(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export { tempPathFor as __tempPathForTests };
