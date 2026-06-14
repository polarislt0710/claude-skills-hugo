// Mission V3 — Git worktree lifecycle for parallel sub-phases.
//   Each parallel sub-phase gets its own worktree + branch off a base commit,
//   runs coding/review there, then its branch is merged back into the main repo
//   serially (between waves). Clean merge → keep; conflict → abort + report so the
//   caller can downgrade that sub-phase to a serial rebuild.
//
//   Used ONLY by the MISSION_PARALLEL path. No-op for flag-off behaviour.

'use strict';

const fs = require('fs');
const { execFileSync } = require('child_process');

// Files produced by session hooks (not the task's real code) that show up in
// every worktree and would otherwise cause spurious merge conflicts. On a merge
// conflict made up ONLY of these, we resolve to the main repo's version instead
// of aborting. Real code conflicts still abort + report.
const SESSION_NOISE_RE = /(^|\/)(HANDOFF\.md|SESSION-LOG\.md|\.session[^/]*|[^/]*\.wip)$/;

function git(repo, args, opts = {}) {
  const { env: optsEnv, ...restOpts } = opts;
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...restOpts,
    // GIT_TERMINAL_PROMPT=0 → never block on a credential prompt (would hang the
    // non-interactive execFileSync). Push auth must be via SSH key / cached token.
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...(optsEnv || {}) },
  });
}

function gitSafe(repo, args) {
  try {
    return { ok: true, out: String(git(repo, args) || '').trim() };
  } catch (e) {
    const err = (e.stderr || e.stdout || e.message || '').toString().trim();
    return { ok: false, out: '', err };
  }
}

function headSha(repo) {
  const r = gitSafe(repo, ['rev-parse', 'HEAD']);
  return r.ok ? r.out : null;
}

// Push the current HEAD (the local merge result of a finished pipeline) to
// origin/<targetBranch>. NON-FORCE only: a non-fast-forward push is reported,
// never overwritten — this protects the live production branch's history.
// Uses a refspec (HEAD:refs/heads/<branch>) so we never have to checkout / rename
// the ephemeral swarm/* branches; the remote branch is auto-created if missing.
// Returns { ok, remoteBranch, pushedSha, err, conflict }.
function pushBranch({ repo, targetBranch, sourceRef = 'HEAD', remote = 'origin' }) {
  const branch = String(targetBranch || '').trim();
  // 1) sanitise branch name (reject anything that could break the refspec)
  if (!branch || !/^[A-Za-z0-9._/-]+$/.test(branch) || branch.includes('..')
      || branch.startsWith('-') || branch.startsWith('/') || branch.endsWith('/')) {
    return { ok: false, err: `invalid branch name: ${targetBranch}`, remoteBranch: branch };
  }
  // 2) refuse to push a half-finished merge state
  if (gitSafe(repo, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']).ok) {
    return { ok: false, err: 'repo is mid-merge (MERGE_HEAD exists)', remoteBranch: branch };
  }
  // 3) remote must exist + be resolvable
  if (!gitSafe(repo, ['remote', 'get-url', remote]).ok) {
    return { ok: false, err: `no '${remote}' remote configured`, remoteBranch: branch };
  }
  // 4) resolve the sha we are about to push (for reporting)
  const shaR = gitSafe(repo, ['rev-parse', sourceRef]);
  const pushedSha = shaR.ok ? shaR.out : null;
  // 5) push HEAD -> refs/heads/<branch> (non-force)
  const r = gitSafe(repo, ['push', remote, `${sourceRef}:refs/heads/${branch}`]);
  if (r.ok) {
    return { ok: true, remoteBranch: branch, pushedSha, remote };
  }
  const conflict = /non-fast-forward|\brejected\b|fetch first|tip of your current branch is behind/i.test(r.err || '');
  return { ok: false, conflict, err: r.err, remoteBranch: branch, pushedSha, remote };
}

function isClean(repo) {
  const r = gitSafe(repo, ['status', '--porcelain']);
  return r.ok && r.out === '';
}

function pruneWorktrees(repo) {
  gitSafe(repo, ['worktree', 'prune']);
}

// Remove a worktree + its branch. Best-effort; never throws.
function removeWorktree({ repo, dir, branch, quiet = false }) {
  if (dir) {
    const r = gitSafe(repo, ['worktree', 'remove', '--force', dir]);
    if (!r.ok) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
      pruneWorktrees(repo);
    }
  } else {
    pruneWorktrees(repo);
  }
  if (branch) gitSafe(repo, ['branch', '-D', branch]);
  if (!quiet) return true;
  return true;
}

// Create an isolated worktree on a fresh branch off baseCommit.
function createWorktree({ repo, baseCommit, branch, dir }) {
  if (!repo || !branch || !dir) throw new Error('createWorktree requires repo, branch, dir');
  // Defensive cleanup of any stale leftovers from a crashed prior run.
  removeWorktree({ repo, dir, branch, quiet: true });
  pruneWorktrees(repo);

  const base = baseCommit || headSha(repo) || 'HEAD';
  let r = gitSafe(repo, ['worktree', 'add', '-b', branch, dir, base]);
  if (!r.ok) {
    // Branch may have survived a crash — nuke it and retry once.
    gitSafe(repo, ['branch', '-D', branch]);
    pruneWorktrees(repo);
    r = gitSafe(repo, ['worktree', 'add', '-b', branch, dir, base]);
    if (!r.ok) throw new Error(`worktree add failed for ${branch}: ${r.err}`);
  }
  return { dir, branch, baseCommit: base };
}

// Commit everything in a worktree (safety net if the agent forgot to commit).
// Returns { committed:boolean, head, empty?:boolean }.
function commitWorktree({ dir, message }) {
  if (isClean(dir)) {
    return { committed: false, empty: true, head: headSha(dir) };
  }
  const add = gitSafe(dir, ['add', '-A']);
  if (!add.ok) return { committed: false, error: add.err, head: headSha(dir) };
  const msg = message || 'mission: auto-commit sub-phase work';
  const c = gitSafe(dir, ['commit', '--no-verify', '-m', msg]);
  if (!c.ok) return { committed: false, error: c.err, head: headSha(dir) };
  return { committed: true, head: headSha(dir) };
}

// Merge a sub-phase branch back into the main repo's current branch.
// Clean → { ok:true }. Conflict/failure → abort + { ok:false, conflict:true }.
function mergeWorktree({ repo, branch, message }) {
  const before = headSha(repo);
  // Nothing to merge if branch == current HEAD (no commits made).
  const ahead = gitSafe(repo, ['rev-list', '--count', `HEAD..${branch}`]);
  if (ahead.ok && ahead.out === '0') {
    return { ok: true, conflict: false, noChanges: true, head: before };
  }
  const msg = message || `mission: merge ${branch}`;
  const r = gitSafe(repo, ['merge', '--no-ff', '-m', msg, branch]);
  if (r.ok) {
    return { ok: true, conflict: false, head: headSha(repo), before };
  }
  // Capture conflicting files.
  const conflicting = gitSafe(repo, ['diff', '--name-only', '--diff-filter=U']);
  const files = conflicting.ok ? conflicting.out.split('\n').filter(Boolean) : [];
  // If the conflict is ONLY session-hook noise (HANDOFF.md etc), resolve to the
  // main repo's version and complete the merge instead of aborting.
  const realConflicts = files.filter((f) => !SESSION_NOISE_RE.test(f));
  if (files.length && realConflicts.length === 0) {
    for (const f of files) gitSafe(repo, ['checkout', '--ours', '--', f]);
    gitSafe(repo, ['add', ...files]);
    const c = gitSafe(repo, ['commit', '--no-edit', '--no-verify']);
    if (c.ok) {
      return { ok: true, conflict: false, resolvedNoise: files, head: headSha(repo), before };
    }
  }
  // Real code conflict → abort to leave the repo pristine.
  gitSafe(repo, ['merge', '--abort']);
  return {
    ok: false,
    conflict: true,
    err: r.err,
    conflictFiles: files,
    head: headSha(repo),
  };
}

module.exports = {
  createWorktree,
  commitWorktree,
  mergeWorktree,
  removeWorktree,
  pruneWorktrees,
  headSha,
  isClean,
  pushBranch,
};
