// git-status.routes.js — exposes repo/session state to the CloudCLI frontend
// (the Git/Session status chip) and a manual "Wrap & Push" trigger.
//
// Mounted at /api/git-status by index.js (GIT_STATUS_ROUTE_PATCH).

import express from 'express';
import path from 'path';
import os from 'os';
import { promises as fs } from 'fs';
import { execFile } from 'child_process';
import { getMissionBase, sanitizeSlug } from '../mission-cwd.service.js';

const router = express.Router();
const REGISTRY = path.join(os.homedir(), '.cloudcli', 'active-sessions.json');
const WRAP_SCRIPT = path.join(os.homedir(), '.claude', 'session-hooks', 'bin', 'session-wrap.sh');

function git(cwd, args, timeout = 5000) {
    return new Promise((resolve) => {
        execFile('git', ['-C', cwd, ...args], { timeout, maxBuffer: 1 << 20 }, (err, stdout) => {
            resolve(err ? '' : String(stdout).trim());
        });
    });
}

function resolveCwd(slug) {
    const base = getMissionBase();
    const clean = sanitizeSlug(slug);
    return clean ? path.join(base, 'missions', clean) : base;
}

async function readRegistry() {
    try {
        const raw = await fs.readFile(REGISTRY, 'utf8');
        const arr = JSON.parse(raw);
        return Array.isArray(arr) ? arr : [];
    } catch {
        return [];
    }
}

router.get('/', async (req, res) => {
    try {
        const cwd = resolveCwd(req.query.slug);
        const top = await git(cwd, ['rev-parse', '--show-toplevel']);
        if (!top) return res.json({ ok: false, error: 'not a git repo', cwd });

        const [branch, porcelain, lastLog, lastWip] = await Promise.all([
            git(top, ['rev-parse', '--abbrev-ref', 'HEAD']),
            git(top, ['status', '--porcelain']),
            git(top, ['log', '-1', '--format=%h|%s|%cr']),
            git(top, ['log', '-1', '--format=%cr', '--grep=auto-save']),
        ]);

        const dirty = porcelain ? porcelain.split('\n').filter(Boolean).length : 0;
        const parts = lastLog.split('|');
        const hash = parts[0] || '';
        const subject = parts[1] || '';
        const when = parts[2] || '';
        const now = Math.floor(Date.now() / 1000);
        const sessions = (await readRegistry())
            .filter((s) => s.repo === top && now - (s.updated || 0) < 2700)
            .map((s) => ({ branch: s.branch, cwd: s.cwd, since: s.started }));

        res.json({
            ok: true,
            repo: path.basename(top),
            branch,
            dirty,
            lastCommit: hash ? { hash, subject, when } : null,
            lastAutoSave: lastWip || null,
            activeSessions: sessions,
            collision: sessions.length > 1,
        });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

router.post('/wrap', async (req, res) => {
    const slug = sanitizeSlug((req.body && req.body.slug) || '');
    const args = slug ? ['--slug', slug] : ['--cwd', getMissionBase()];
    execFile('bash', [WRAP_SCRIPT, ...args], { timeout: 30000, maxBuffer: 1 << 20 }, (err, stdout) => {
        if (err) return res.status(500).json({ ok: false, error: err.message, raw: String(stdout) });
        try {
            res.json(JSON.parse(String(stdout).trim().split('\n').pop()));
        } catch {
            res.json({ ok: true, raw: String(stdout).trim() });
        }
    });
});

export default router;
