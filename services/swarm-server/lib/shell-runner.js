const SHELL_BOOTSTRAP = [
  'export PATH="$HOME/.local/bin:$HOME/bin:$PATH"',
  '[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1 || true',
  '[ -s "$HOME/.cargo/env" ] && . "$HOME/.cargo/env" >/dev/null 2>&1 || true',
].join('; ');

const NON_TTY_SHELL_NOISE = [
  /^bash: cannot set terminal process group.*$/gm,
  /^bash: no job control in this shell.*$/gm,
];

function bashLoginArgs(command, argv0 = 'swarm-shell', ...args) {
  return ['-lc', `${SHELL_BOOTSTRAP}; ${command}`, argv0, ...args];
}

function stripNonTtyShellNoise(value) {
  let out = String(value || '');
  for (const pattern of NON_TTY_SHELL_NOISE) out = out.replace(pattern, '');
  return out.trim();
}

module.exports = { bashLoginArgs, stripNonTtyShellNoise, SHELL_BOOTSTRAP };
