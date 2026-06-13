// Run: node lib/mission-worktree.test.js   (uses a throwaway repo in os.tmpdir)
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const wt = require('./mission-worktree');

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-test-'));
const repo = path.join(root, 'repo');
fs.mkdirSync(repo, { recursive: true });
git(repo, 'init', '-q');
git(repo, 'config', 'user.email', 'test@example.com');
git(repo, 'config', 'user.name', 'Test');
git(repo, 'config', 'commit.gpgsign', 'false');
fs.writeFileSync(path.join(repo, 'base.txt'), 'base\n');
fs.writeFileSync(path.join(repo, 'shared.txt'), 'original\n');
git(repo, 'add', '-A');
git(repo, 'commit', '-q', '-m', 'init');
const base = wt.headSha(repo);

console.log('mission-worktree');

test('createWorktree makes an isolated dir + branch off base', () => {
  const dir = path.join(root, 'wt-a');
  const r = wt.createWorktree({ repo, baseCommit: base, branch: 'mission/test/p1', dir });
  assert.strictEqual(r.dir, dir);
  assert.ok(fs.existsSync(dir), 'worktree dir exists');
  assert.ok(fs.existsSync(path.join(dir, 'base.txt')), 'base file checked out');
  const branches = git(repo, 'branch', '--list', 'mission/test/p1');
  assert.ok(branches.includes('mission/test/p1'), 'branch exists');
});

test('commitWorktree captures new work', () => {
  const dir = path.join(root, 'wt-a');
  fs.writeFileSync(path.join(dir, 'feature-a.txt'), 'A\n');
  const c = wt.commitWorktree({ dir, message: 'p1: add feature a' });
  assert.strictEqual(c.committed, true);
});

test('mergeWorktree brings work into main repo (clean)', () => {
  const r = wt.mergeWorktree({ repo, branch: 'mission/test/p1' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.conflict, false);
  assert.ok(fs.existsSync(path.join(repo, 'feature-a.txt')), 'merged file present in main repo');
});

test('removeWorktree cleans dir + branch', () => {
  const dir = path.join(root, 'wt-a');
  wt.removeWorktree({ repo, dir, branch: 'mission/test/p1' });
  assert.ok(!fs.existsSync(dir), 'worktree dir removed');
  const branches = git(repo, 'branch', '--list', 'mission/test/p1');
  assert.strictEqual(branches.trim(), '', 'branch deleted');
});

test('mergeWorktree with no commits → noChanges, repo untouched', () => {
  const dir = path.join(root, 'wt-empty');
  const headBefore = wt.headSha(repo);
  wt.createWorktree({ repo, baseCommit: wt.headSha(repo), branch: 'mission/test/empty', dir });
  const r = wt.mergeWorktree({ repo, branch: 'mission/test/empty' });
  assert.strictEqual(r.noChanges, true);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(wt.headSha(repo), headBefore, 'HEAD unchanged');
  wt.removeWorktree({ repo, dir, branch: 'mission/test/empty' });
});

test('conflicting merge → abort, repo stays clean on main version', () => {
  const forkPoint = wt.headSha(repo);
  // worktree edits shared.txt one way...
  const dir = path.join(root, 'wt-conf');
  wt.createWorktree({ repo, baseCommit: forkPoint, branch: 'mission/test/conf', dir });
  fs.writeFileSync(path.join(dir, 'shared.txt'), 'worktree version\n');
  wt.commitWorktree({ dir, message: 'conf: worktree edit' });
  // ...main edits the same file another way
  fs.writeFileSync(path.join(repo, 'shared.txt'), 'main version\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'main edit shared');
  const mainHead = wt.headSha(repo);

  const r = wt.mergeWorktree({ repo, branch: 'mission/test/conf' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.conflict, true);
  assert.ok(r.conflictFiles.includes('shared.txt'), 'reports conflicting file');
  assert.strictEqual(wt.headSha(repo), mainHead, 'HEAD rolled back to pre-merge');
  assert.ok(wt.isClean(repo), 'repo is clean after abort (no half-merge)');
  assert.strictEqual(fs.readFileSync(path.join(repo, 'shared.txt'), 'utf8'), 'main version\n');
  wt.removeWorktree({ repo, dir, branch: 'mission/test/conf' });
});

test('noise-only conflict (HANDOFF.md) → resolved to ours, merge completes', () => {
  const forkPoint = wt.headSha(repo);
  const dir = path.join(root, 'wt-noise');
  wt.createWorktree({ repo, baseCommit: forkPoint, branch: 'mission/test/noise', dir });
  fs.writeFileSync(path.join(dir, 'HANDOFF.md'), 'worktree handoff\n');
  fs.writeFileSync(path.join(dir, 'feature-n.txt'), 'N\n'); // real new file, no conflict
  wt.commitWorktree({ dir, message: 'noise: handoff + feature' });
  // main edits HANDOFF.md a different way → would conflict
  fs.writeFileSync(path.join(repo, 'HANDOFF.md'), 'main handoff\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'main handoff');

  const r = wt.mergeWorktree({ repo, branch: 'mission/test/noise' });
  assert.strictEqual(r.ok, true, 'noise-only conflict resolved, merge ok');
  assert.ok(r.resolvedNoise && r.resolvedNoise.includes('HANDOFF.md'), 'reports resolved noise');
  assert.strictEqual(fs.readFileSync(path.join(repo, 'HANDOFF.md'), 'utf8'), 'main handoff\n', 'kept main version');
  assert.ok(fs.existsSync(path.join(repo, 'feature-n.txt')), 'real new file still merged');
  wt.removeWorktree({ repo, dir, branch: 'mission/test/noise' });
});

// cleanup
try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
console.log(`\n${passed} passed`);
