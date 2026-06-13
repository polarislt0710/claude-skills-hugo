// Mission Agent runner — spawn CLI subprocess, stream lines, return final stdout.
// Supports: claude (with --model), codex, glm.
// Agents produce ```file:path\n<content>\n``` blocks; parseFileBlocks() extracts them.

const { spawn } = require('child_process');

const CODEX_BASE_ARGS = [
  'exec',
  '--sandbox',
  'danger-full-access',
  '--dangerously-bypass-approvals-and-sandbox',
  '--skip-git-repo-check',
];

function codexArgs(model) {
  return [...CODEX_BASE_ARGS, '--model', model, '-'];
}

const CLI_REGISTRY = {
  // Claude variants — bypass permissions so Read/Write tools work in cwd
  'opus':           { bin: 'claude', extraArgs: ['-p', '--output-format', 'text', '--permission-mode', 'bypassPermissions', '--model', 'opus'] },
  'sonnet':         { bin: 'claude', extraArgs: ['-p', '--output-format', 'text', '--permission-mode', 'bypassPermissions', '--model', 'sonnet'] },
  'haiku':          { bin: 'claude', extraArgs: ['-p', '--output-format', 'text', '--permission-mode', 'bypassPermissions', '--model', 'haiku'] },
  'claude-default': { bin: 'claude', extraArgs: ['-p', '--output-format', 'text', '--permission-mode', 'bypassPermissions'] },
  // GLM wrapper = `claude` with BigModel env — same args as Claude
  'glm-5.1':        { bin: 'glm',    extraArgs: ['-p', '--output-format', 'text', '--permission-mode', 'bypassPermissions'] },
  'glm':            { bin: 'glm',    extraArgs: ['-p', '--output-format', 'text', '--permission-mode', 'bypassPermissions'] },
  // Codex CLI — non-interactive mode is `codex exec -`; prompt is piped via stdin.
  'codex':          { bin: 'codex',  extraArgs: codexArgs('gpt-5.5') },
  'gpt-5.5':        { bin: 'codex',  extraArgs: codexArgs('gpt-5.5') },
  'gpt-5.4':        { bin: 'codex',  extraArgs: codexArgs('gpt-5.4') },
  'gpt-5.4-mini':   { bin: 'codex',  extraArgs: codexArgs('gpt-5.4-mini') },
  'gpt-5.3-codex':  { bin: 'codex',  extraArgs: codexArgs('gpt-5.3-codex') },
  'gpt-5.2':        { bin: 'codex',  extraArgs: codexArgs('gpt-5.2') },
  'o3':             { bin: 'codex',  extraArgs: codexArgs('o3') },
};

const DEFAULT_TIMEOUT_MS = Number(process.env.MISSION_AGENT_TIMEOUT_MS || 30 * 60 * 1000); // 30 min

function runAgent(opts) {
  const { model, prompt, cwd, onLine, onErr, timeoutMs } = opts;
  if (!CLI_REGISTRY[model]) {
    return Promise.reject(new Error(`unknown model: ${model} (valid: ${Object.keys(CLI_REGISTRY).join(', ')})`));
  }

  return new Promise((resolve, reject) => {
    const { bin, extraArgs } = CLI_REGISTRY[model];
    const cmd = `${bin} ${extraArgs.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(' ')}`;

    const child = spawn('bash', ['-ic', cmd], {
      cwd: cwd || process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    let stdout = '';
    let stderr = '';
    let lineBuf = '';
    const start = Date.now();
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch {}
      setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 3000);
    }, timeoutMs || DEFAULT_TIMEOUT_MS);

    child.stdout.on('data', (chunk) => {
      const s = chunk.toString();
      stdout += s;
      lineBuf += s;
      let nl;
      while ((nl = lineBuf.indexOf('\n')) !== -1) {
        const line = lineBuf.slice(0, nl);
        lineBuf = lineBuf.slice(nl + 1);
        if (onLine) onLine(line);
      }
    });

    child.stderr.on('data', (chunk) => {
      const s = chunk.toString();
      stderr += s;
      if (onErr) onErr(s);
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (lineBuf && onLine) onLine(lineBuf);
      if (timedOut) {
        return reject(new Error(`agent timeout after ${timeoutMs || DEFAULT_TIMEOUT_MS}ms (model=${model})`));
      }
      resolve({
        stdout,
        stderr,
        exitCode: code,
        durationMs: Date.now() - start,
        model,
      });
    });

    try {
      child.stdin.write(prompt);
      child.stdin.end();
    } catch (err) {
      clearTimeout(timer);
      reject(err);
    }
  });
}

// Parse ```file:relative/path\n<content>\n``` blocks from agent stdout
function parseFileBlocks(text) {
  const out = [];
  const regex = /```file:([^\n`]+)\n([\s\S]*?)\n```/g;
  let m;
  while ((m = regex.exec(text)) !== null) {
    const pathStr = m[1].trim();
    if (!pathStr) continue;
    // Reject absolute paths or path traversal
    if (pathStr.startsWith('/') || pathStr.includes('..')) continue;
    out.push({ path: pathStr, content: m[2] });
  }
  return out;
}

module.exports = { runAgent, parseFileBlocks, CLI_REGISTRY };
