const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const EXCLUDED_NAMES = new Set([
  '.git',
  '.next',
  '.turbo',
  '.cache',
  '.venv',
  '__pycache__',
  'build',
  'coverage',
  'dist',
  'missions',
  'node_modules',
]);

const MAX_HASH_BYTES = Number(process.env.MISSION_SNAPSHOT_MAX_HASH_BYTES || 8 * 1024 * 1024);

function toRel(root, filePath) {
  return path.relative(root, filePath).replace(/\\/g, '/');
}

function isExcludedRel(relPath) {
  const parts = String(relPath || '').split('/').filter(Boolean);
  return parts.some((part) => EXCLUDED_NAMES.has(part));
}

function listGitFiles(root) {
  const out = execFileSync(
    'git',
    ['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { encoding: 'buffer', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }
  );
  return out.toString('utf8').split('\0').filter(Boolean);
}

function walkFiles(root, dir = root, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const rel = toRel(root, full);
    if (isExcludedRel(rel)) continue;
    if (entry.isDirectory()) walkFiles(root, full, out);
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

function listProjectFiles(root) {
  try {
    return listGitFiles(root).filter((rel) => !isExcludedRel(rel));
  } catch {
    return walkFiles(root).filter((rel) => !isExcludedRel(rel));
  }
}

function hashFile(fullPath, stat) {
  if (stat.size > MAX_HASH_BYTES) {
    return `large:${stat.size}:${Math.round(stat.mtimeMs)}`;
  }
  const content = fs.readFileSync(fullPath);
  return crypto.createHash('sha1').update(content).digest('hex');
}

function snapshotProject(root) {
  const startedAt = Date.now();
  const files = {};
  if (!root || !fs.existsSync(root)) {
    return { root, capturedAt: startedAt, durationMs: 0, files, error: 'project root not found' };
  }

  const relFiles = Array.from(new Set(listProjectFiles(root))).sort();
  for (const rel of relFiles) {
    const full = path.join(root, rel);
    let stat;
    try {
      stat = fs.statSync(full);
      if (!stat.isFile()) continue;
      files[rel] = {
        hash: hashFile(full, stat),
        size: stat.size,
        mtimeMs: Math.round(stat.mtimeMs),
      };
    } catch {}
  }
  return { root, capturedAt: startedAt, durationMs: Date.now() - startedAt, files };
}

function diffProjectSnapshots(before, after) {
  const beforeFiles = (before && before.files) || {};
  const afterFiles = (after && after.files) || {};
  const keys = new Set([...Object.keys(beforeFiles), ...Object.keys(afterFiles)]);
  const added = [];
  const modified = [];
  const deleted = [];

  for (const rel of Array.from(keys).sort()) {
    const b = beforeFiles[rel];
    const a = afterFiles[rel];
    if (!b && a) added.push(rel);
    else if (b && !a) deleted.push(rel);
    else if (b && a && b.hash !== a.hash) modified.push(rel);
  }

  const touchedFiles = [...added, ...modified, ...deleted].sort();
  return {
    added,
    modified,
    deleted,
    touchedFiles,
    counts: {
      added: added.length,
      modified: modified.length,
      deleted: deleted.length,
      touched: touchedFiles.length,
    },
  };
}

function mergeTouchedFiles(existing, changes) {
  const merged = new Set(Array.isArray(existing) ? existing : []);
  for (const file of (changes && changes.touchedFiles) || []) merged.add(file);
  return Array.from(merged).sort();
}

module.exports = {
  diffProjectSnapshots,
  mergeTouchedFiles,
  snapshotProject,
};
