import path from 'path';
import os from 'os';
import { promises as fs } from 'fs';

const MISSION_BASE = process.env.MISSION_BASE_PROJECT
    || path.join(os.homedir(), 'orca-platform-mvp');

function sanitizeSlug(value) {
    if (typeof value !== 'string') return '';
    return value.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}

export async function resolveMissionCwd(options) {
    if (!options || typeof options !== 'object') return options;
    const slug = sanitizeSlug(options.missionSlug);
    if (!slug) return options;
    const missionDir = path.join(MISSION_BASE, 'missions', slug);
    try {
        await fs.mkdir(missionDir, { recursive: true });
    } catch (err) {
        console.error('[mission-cwd] mkdir failed', missionDir, err);
        return options;
    }
    console.log('[mission-cwd] redirect cwd ->', missionDir);
    return { ...options, cwd: missionDir };
}

export async function resolveMissionWorkspace(command, options) {
    const resolvedOptions = await resolveMissionCwd(options);
    return {
        command,
        options: resolvedOptions,
    };
}

export function getMissionBase() {
    return MISSION_BASE;
}

export { sanitizeSlug };
