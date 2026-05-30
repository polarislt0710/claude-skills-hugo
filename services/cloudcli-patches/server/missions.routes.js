import express from 'express';
import path from 'path';
import { promises as fs } from 'fs';
import { getMissionBase, sanitizeSlug } from '../mission-cwd.service.js';

const router = express.Router();

function deriveSlugFromFilename(filename) {
    return filename.replace(/^MISSION-/i, '').replace(/\.md$/i, '').toLowerCase().replace(/[^a-z0-9-]+/g, '-');
}

async function readTitle(filePath) {
    try {
        const handle = await fs.open(filePath, 'r');
        const buf = Buffer.alloc(512);
        await handle.read(buf, 0, 512, 0);
        await handle.close();
        const head = buf.toString('utf8');
        const firstLine = head.split('\n')[0] || '';
        const match = firstLine.match(/^#\s*MISSION\s*[—\-:]\s*(.+?)\s*$/i);
        if (match) return match[1].trim();
        return firstLine.replace(/^#\s*/, '').trim() || null;
    } catch (err) {
        return null;
    }
}

router.get('/', async (_req, res) => {
    try {
        const base = getMissionBase();
        const entries = await fs.readdir(base, { withFileTypes: true });
        const missions = [];
        for (const entry of entries) {
            if (!entry.isFile()) continue;
            if (!/^MISSION-.+\.md$/i.test(entry.name)) continue;
            const filePath = path.join(base, entry.name);
            const slug = deriveSlugFromFilename(entry.name);
            const title = await readTitle(filePath);
            missions.push({
                slug,
                filename: entry.name,
                title: title || slug,
                file: filePath,
                folder: path.join(base, 'missions', slug),
            });
        }
        missions.sort((a, b) => a.slug.localeCompare(b.slug));
        res.json({ base, missions });
    } catch (err) {
        console.error('[missions] list failed', err);
        res.status(500).json({ error: err.message });
    }
});

router.post('/:slug/ensure', async (req, res) => {
    const slug = sanitizeSlug(req.params.slug);
    if (!slug) return res.status(400).json({ error: 'invalid slug' });
    const folder = path.join(getMissionBase(), 'missions', slug);
    try {
        await fs.mkdir(folder, { recursive: true });
        res.json({ slug, folder, created: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.get('/:slug/files', async (req, res) => {
    const slug = sanitizeSlug(req.params.slug);
    if (!slug) return res.status(400).json({ error: 'invalid slug' });
    const folder = path.join(getMissionBase(), 'missions', slug);
    try {
        const entries = await fs.readdir(folder, { withFileTypes: true });
        const files = entries.map(e => ({ name: e.name, isDir: e.isDirectory() }));
        res.json({ slug, folder, files });
    } catch (err) {
        if (err.code === 'ENOENT') return res.json({ slug, folder, files: [] });
        res.status(500).json({ error: err.message });
    }
});

export default router;
