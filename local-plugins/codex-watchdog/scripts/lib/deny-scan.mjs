/**
 * codex-watchdog — sandbox-deny detection.
 *
 * The official openai-codex plugin hard-overrides the Codex sandbox when it
 * dispatches work (read-only or workspace-write) plus `approvalPolicy: "never"`.
 * A user's `~/.codex/config.toml` `danger-full-access` does NOT apply to
 * plugin-dispatched jobs, so Codex silently hits permission walls.
 *
 * This module is a pure annotator: it reads log lines and reports whether they
 * smell like a sandbox denial. It NEVER changes how a job is classified —
 * classification rules live in classify.mjs and stay untouched.
 */

export const MAX_DENY_MATCHES = 5;

/**
 * Ordered most-specific-first: the first pattern that matches a line names it.
 */
export const DENY_PATTERNS = Object.freeze([
  { pattern: "operation-not-permitted", regex: /operation not permitted/i },
  { pattern: "read-only-file-system", regex: /read-only file system/i },
  { pattern: "network-unreachable", regex: /network (?:is )?unreachable/i },
  { pattern: "no-network", regex: /no network/i },
  { pattern: "network-access", regex: /network access/i },
  { pattern: "requires-approval", regex: /requires approval/i },
  { pattern: "not-permitted", regex: /not permitted/i },
  { pattern: "eperm", regex: /\bEPERM\b/i },
  { pattern: "eacces", regex: /\bEACCES\b/i },
  { pattern: "sandbox", regex: /sandbox/i },
  { pattern: "denied", regex: /\bdenied\b/i },
  { pattern: "deny", regex: /\bdeny\b/i },
  { pattern: "blocked", regex: /\bblocked\b/i }
]);

function toLines(input) {
  if (Array.isArray(input)) return input;
  if (typeof input === "string") return input.split("\n");
  return [];
}

/**
 * @param {string[]|string} lines log lines (or a raw log chunk)
 * @returns {{ suspected: boolean, matches: Array<{line: string, pattern: string}> }}
 */
export function scanForSandboxDeny(lines) {
  const matches = [];
  for (const raw of toLines(lines)) {
    if (matches.length >= MAX_DENY_MATCHES) break;
    if (typeof raw !== "string") continue;
    const line = raw.trimEnd();
    if (line.trim() === "") continue;
    const hit = DENY_PATTERNS.find((candidate) => candidate.regex.test(line));
    if (hit) matches.push({ line, pattern: hit.pattern });
  }
  return { suspected: matches.length > 0, matches };
}
