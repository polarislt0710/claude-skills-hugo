import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MAP_PATH = path.join(os.homedir(), '.cloudcli', 'mission-session-map.json');
const ROOT_PROJECT_DISPLAY_NAME = 'ORCA Platform';

function readMap() {
  try {
    return JSON.parse(fs.readFileSync(MAP_PATH, 'utf8'));
  }
  catch {
    return {};
  }
}

export function applyMissionSessionMapping(parsed, projectsDb) {
  if (!parsed?.sessionId) {
    return parsed;
  }
  const mapping = readMap()[parsed.sessionId];
  if (!mapping?.targetProject) {
    return parsed;
  }
  const targetProject = mapping.targetProject;
  if (projectsDb) {
    try {
      projectsDb.createProjectPath(targetProject, ROOT_PROJECT_DISPLAY_NAME);
      projectsDb.updateCustomProjectName(targetProject, ROOT_PROJECT_DISPLAY_NAME);
    }
    catch (err) {
      console.warn('[mission-session-map] project name update failed', err?.message || err);
    }
  }
  return {
    ...parsed,
    projectPath: targetProject,
  };
}
