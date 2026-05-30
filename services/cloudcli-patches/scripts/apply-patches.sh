#!/usr/bin/env bash
# Idempotently apply Hugo's Mission feature patches to CloudCLI.
# Safe to re-run after `npm update -g @cloudcli-ai/cloudcli`.

set -euo pipefail

CLOUDCLI_ROOT="${CLOUDCLI_ROOT:-$(npm root -g)/@cloudcli-ai/cloudcli}"
PATCH_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ ! -d "$CLOUDCLI_ROOT" ]; then
    echo "ERROR: CloudCLI not found at $CLOUDCLI_ROOT" >&2
    exit 1
fi

DIST_SERVER="$CLOUDCLI_ROOT/dist-server/server"
DIST="$CLOUDCLI_ROOT/dist"

echo "==> CloudCLI root: $CLOUDCLI_ROOT"

# --- 1. Copy backend new files ---
echo "==> Copying backend Mission files"
cp "$PATCH_DIR/server/mission-cwd.service.js" "$DIST_SERVER/mission-cwd.service.js"
cp "$PATCH_DIR/server/mission-session-map.service.js" "$DIST_SERVER/mission-session-map.service.js"
mkdir -p "$DIST_SERVER/routes"
cp "$PATCH_DIR/server/missions.routes.js" "$DIST_SERVER/routes/missions.js"
cp "$PATCH_DIR/server/git-status.routes.js" "$DIST_SERVER/routes/git-status.js"

# --- 2. Patch chat-websocket.service.js (idempotent) ---
WS_FILE="$DIST_SERVER/modules/websocket/services/chat-websocket.service.js"
if ! grep -Eq "MISSION_CWD_PATCH|MISSION_WORKSPACE_PATCH" "$WS_FILE"; then
    echo "==> Patching chat-websocket.service.js"
    # Add import after the existing imports block (line 3 onwards)
    python3 - "$WS_FILE" <<'PY'
import sys, re
fp = sys.argv[1]
src = open(fp).read()

if 'MISSION_CWD_PATCH' in src:
    sys.exit(0)

import_line = "import { resolveMissionCwd } from '../../../mission-cwd.service.js'; // MISSION_CWD_PATCH\n"
# Insert after last top-level "import ... from ..." line
last_import = 0
for m in re.finditer(r"^import .*?;\s*$", src, re.M):
    last_import = m.end()
src = src[:last_import] + "\n" + import_line + src[last_import:]

# Wrap each provider dispatch call. We replace e.g.
#   await dependencies.queryClaudeSDK(data.command ?? '', data.options, writer);
# with a 2-line equivalent that resolves missionSlug first.
patterns = [
    (r"await dependencies\.queryClaudeSDK\(data\.command \?\? '', data\.options, writer\);",
     "{ const _missionOpts = await resolveMissionCwd(data.options); /* MISSION_CWD_PATCH */ await dependencies.queryClaudeSDK(data.command ?? '', _missionOpts, writer); }"),
    (r"await dependencies\.spawnCursor\(data\.command \?\? '', data\.options, writer\);",
     "{ const _missionOpts = await resolveMissionCwd(data.options); /* MISSION_CWD_PATCH */ await dependencies.spawnCursor(data.command ?? '', _missionOpts, writer); }"),
    (r"await dependencies\.queryCodex\(data\.command \?\? '', data\.options, writer\);",
     "{ const _missionOpts = await resolveMissionCwd(data.options); /* MISSION_CWD_PATCH */ await dependencies.queryCodex(data.command ?? '', _missionOpts, writer); }"),
    (r"await dependencies\.spawnGemini\(data\.command \?\? '', data\.options, writer\);",
     "{ const _missionOpts = await resolveMissionCwd(data.options); /* MISSION_CWD_PATCH */ await dependencies.spawnGemini(data.command ?? '', _missionOpts, writer); }"),
]
for pat, repl in patterns:
    new, n = re.subn(pat, repl, src, count=1)
    if n != 1:
        print(f"WARN: pattern not matched: {pat[:60]}...", file=sys.stderr)
    src = new

open(fp, 'w').write(src)
print("patched chat-websocket.service.js")
PY
else
    echo "==> chat-websocket.service.js already patched, skipping"
fi

# --- 3. Patch sessions.db.js (Mission display project mapping) ---
SESSIONS_DB_FILE="$DIST_SERVER/modules/database/repositories/sessions.db.js"
if ! grep -q "MISSION_SESSION_MAP_PATCH" "$SESSIONS_DB_FILE"; then
    echo "==> Patching sessions.db.js"
    python3 - "$SESSIONS_DB_FILE" <<'PY'
import sys, re
fp = sys.argv[1]
src = open(fp).read()
if 'MISSION_SESSION_MAP_PATCH' in src:
    sys.exit(0)

src = re.sub(
    r"(import \{ normalizeProjectPath \} from '../../../shared/utils\.js';)",
    r"\1\nimport { applyMissionSessionMapping } from '../../../mission-session-map.service.js'; // MISSION_SESSION_MAP_PATCH",
    src,
    count=1,
)
src = src.replace(
    "        const normalizedProjectPath = normalizeProjectPathForProvider(provider, projectPath);",
    "        const mappedSession = applyMissionSessionMapping({ sessionId, provider, projectPath, customName }, projectsDb); // MISSION_SESSION_MAP_PATCH\n        const normalizedProjectPath = normalizeProjectPathForProvider(provider, mappedSession.projectPath ?? projectPath);",
)
open(fp, 'w').write(src)
print("patched sessions.db.js")
PY
else
    echo "==> sessions.db.js already patched, skipping"
fi

# --- 4. Patch index.js (mount missions routes) ---
IDX_FILE="$DIST_SERVER/index.js"
if ! grep -q "MISSIONS_ROUTE_PATCH" "$IDX_FILE"; then
    echo "==> Patching index.js"
    python3 - "$IDX_FILE" <<'PY'
import sys, re
fp = sys.argv[1]
src = open(fp).read()
if 'MISSIONS_ROUTE_PATCH' in src:
    sys.exit(0)

# Add import after pluginsRoutes import
src = re.sub(
    r"(import pluginsRoutes from '\./routes/plugins\.js';)",
    r"\1\nimport missionsRoutes from './routes/missions.js'; // MISSIONS_ROUTE_PATCH",
    src, count=1
)

# Mount after pluginsRoutes mount
src = re.sub(
    r"(app\.use\('/api/plugins', authenticateToken, pluginsRoutes\);)",
    r"\1\napp.use('/api/missions', authenticateToken, missionsRoutes); // MISSIONS_ROUTE_PATCH",
    src, count=1
)

open(fp, 'w').write(src)
print("patched index.js")
PY
else
    echo "==> index.js already patched, skipping"
fi

# --- 4b. Patch index.js (mount git-status routes) ---
if ! grep -q "GIT_STATUS_ROUTE_PATCH" "$IDX_FILE"; then
    echo "==> Patching index.js (git-status route)"
    python3 - "$IDX_FILE" <<'PY'
import sys, re
fp = sys.argv[1]
src = open(fp).read()
if 'GIT_STATUS_ROUTE_PATCH' in src:
    sys.exit(0)
src = re.sub(
    r"(import missionsRoutes from '\./routes/missions\.js'; // MISSIONS_ROUTE_PATCH)",
    r"\1\nimport gitStatusRoutes from './routes/git-status.js'; // GIT_STATUS_ROUTE_PATCH",
    src, count=1
)
src = re.sub(
    r"(app\.use\('/api/missions', authenticateToken, missionsRoutes\); // MISSIONS_ROUTE_PATCH)",
    r"\1\napp.use('/api/git-status', authenticateToken, gitStatusRoutes); // GIT_STATUS_ROUTE_PATCH",
    src, count=1
)
open(fp, 'w').write(src)
print("patched index.js git-status route")
PY
else
    echo "==> index.js git-status route already patched, skipping"
fi

# --- 5. Patch openai-codex.js (Codex reasoning effort) ---
CODEX_FILE="$DIST_SERVER/openai-codex.js"
if ! grep -q "HUGO_REASONING_EFFORT_PATCH" "$CODEX_FILE"; then
    echo "==> Patching openai-codex.js reasoning effort"
    python3 - "$CODEX_FILE" <<'PY'
import sys
fp = sys.argv[1]
src = open(fp).read()
if 'HUGO_REASONING_EFFORT_PATCH' in src:
    sys.exit(0)

src = src.replace(
    "function mapPermissionModeToCodexOptions(permissionMode) {",
    """const HUGO_REASONING_EFFORTS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh']); // HUGO_REASONING_EFFORT_PATCH

function normalizeReasoningEffort(value) {
    return HUGO_REASONING_EFFORTS.has(value) ? value : undefined;
}

function mapPermissionModeToCodexOptions(permissionMode) {""",
    1,
)
src = src.replace(
    "    const { sessionId, sessionSummary, cwd, projectPath, model, permissionMode = 'default' } = options;",
    "    const { sessionId, sessionSummary, cwd, projectPath, model, permissionMode = 'default', reasoningEffort } = options; // HUGO_REASONING_EFFORT_PATCH",
    1,
)
src = src.replace(
    "    const { sandboxMode, approvalPolicy } = mapPermissionModeToCodexOptions(permissionMode);",
    "    const { sandboxMode, approvalPolicy } = mapPermissionModeToCodexOptions(permissionMode);\n    const modelReasoningEffort = normalizeReasoningEffort(reasoningEffort); // HUGO_REASONING_EFFORT_PATCH",
    1,
)
src = src.replace(
    """            sandboxMode,
            approvalPolicy,
            model
        };""",
    """            sandboxMode,
            approvalPolicy,
            model,
            modelReasoningEffort
        };""",
    1,
)
open(fp, 'w').write(src)
print("patched openai-codex.js")
PY
else
    echo "==> openai-codex.js already patched, skipping"
fi

# --- 6. Copy frontend overlay files ---
echo "==> Copying frontend Mission overlay"
cp "$PATCH_DIR/dist/cloudcli-hugo-mission.js" "$DIST/cloudcli-hugo-mission.js"
cp "$PATCH_DIR/dist/cloudcli-hugo-mission.css" "$DIST/cloudcli-hugo-mission.css"
echo "==> Copying frontend Session chip"
cp "$PATCH_DIR/dist/cloudcli-hugo-session.js" "$DIST/cloudcli-hugo-session.js"
cp "$PATCH_DIR/dist/cloudcli-hugo-session.css" "$DIST/cloudcli-hugo-session.css"

# --- 7. Patch index.html ---
HTML_FILE="$DIST/index.html"
VER=$(date +%s)
if ! grep -q "cloudcli-hugo-mission" "$HTML_FILE"; then
    echo "==> Patching index.html"
    # Add CSS link after themes CSS
    sed -i.bak "s|<link rel=\"stylesheet\" href=\"/cloudcli-hugo-themes.css\(?v=[0-9]*\)\?\">|&\n  <link rel=\"stylesheet\" href=\"/cloudcli-hugo-mission.css?v=${VER}\">|" "$HTML_FILE"
    # Add JS script after themes JS
    sed -i.bak "s|<script src=\"/cloudcli-hugo-themes.js\(?v=[0-9]*\)\?\"></script>|&\n  <script src=\"/cloudcli-hugo-mission.js?v=${VER}\"></script>|" "$HTML_FILE"
    rm -f "${HTML_FILE}.bak"
else
    echo "==> Refreshing index.html Mission asset cache busters"
    python3 - "$HTML_FILE" "$VER" <<'PY'
import sys, re
fp, ver = sys.argv[1], sys.argv[2]
src = open(fp).read()
src = re.sub(r'/cloudcli-hugo-mission\.css(?:\?v=[0-9]+)?', f'/cloudcli-hugo-mission.css?v={ver}', src)
src = re.sub(r'/cloudcli-hugo-mission\.js(?:\?v=[0-9]+)?', f'/cloudcli-hugo-mission.js?v={ver}', src)
open(fp, 'w').write(src)
PY
fi

# --- 7b. Patch index.html (Session chip assets) ---
if ! grep -q "cloudcli-hugo-session" "$HTML_FILE"; then
    echo "==> Patching index.html (Session chip)"
    sed -i.bak "s|<link rel=\"stylesheet\" href=\"/cloudcli-hugo-mission.css\(?v=[0-9]*\)\?\">|&\n  <link rel=\"stylesheet\" href=\"/cloudcli-hugo-session.css?v=${VER}\">|" "$HTML_FILE"
    sed -i.bak "s|<script src=\"/cloudcli-hugo-mission.js\(?v=[0-9]*\)\?\"></script>|&\n  <script src=\"/cloudcli-hugo-session.js?v=${VER}\"></script>|" "$HTML_FILE"
    rm -f "${HTML_FILE}.bak"
else
    echo "==> Refreshing index.html Session asset cache busters"
    python3 - "$HTML_FILE" "$VER" <<'PY'
import sys, re
fp, ver = sys.argv[1], sys.argv[2]
src = open(fp).read()
src = re.sub(r'/cloudcli-hugo-session\.css(?:\?v=[0-9]+)?', f'/cloudcli-hugo-session.css?v={ver}', src)
src = re.sub(r'/cloudcli-hugo-session\.js(?:\?v=[0-9]+)?', f'/cloudcli-hugo-session.js?v={ver}', src)
open(fp, 'w').write(src)
PY
fi

echo ""
echo "==> All patches applied. Restart cloudcli to take effect:"
echo "    pm2 restart cloudcli"
