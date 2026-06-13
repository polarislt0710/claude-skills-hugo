const { spawn } = require('child_process');

const CLAUDE_BIN = process.env.AUTOMATION_CLAUDE_BIN || 'claude';
const CLAUDE_TIMEOUT_MS = Number(process.env.AUTOMATION_CLAUDE_TIMEOUT_MS || 240000);

function callClaude(prompt, opts = {}) {
  return new Promise((resolve, reject) => {
    const timeoutMs = opts.timeoutMs || CLAUDE_TIMEOUT_MS;
    const args = ['-p', '--output-format', 'text'];
    if (opts.model) args.push('--model', opts.model);

    const cmd = `${CLAUDE_BIN} ${args.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(' ')}`;
    const child = spawn('bash', ['-ic', cmd], { stdio: ['pipe', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch {}
      setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 2000);
    }, timeoutMs);

    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error(`claude -p timeout after ${timeoutMs}ms`));
      if (code !== 0) return reject(new Error(`claude -p exited ${code}: ${stderr.slice(-500) || stdout.slice(-500)}`));
      resolve(stdout.trim());
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

module.exports = { callClaude };
