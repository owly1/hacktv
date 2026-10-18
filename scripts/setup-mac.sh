#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
[[ "$(uname -s)" == Darwin ]] || { echo 'This setup is for macOS.' >&2; exit 1; }
command -v node >/dev/null || { echo 'Install Node.js 22 or newer first.' >&2; exit 1; }
node -e 'if (Number(process.versions.node.split(".")[0]) < 22) process.exit(1)'
command -v uv >/dev/null || { echo 'Install uv first: brew install uv' >&2; exit 1; }
npm ci --ignore-scripts
[[ -d .venv ]] || uv venv --python 3.11 .venv
uv pip install --python .venv/bin/python -r bridge/requirements-laptop.txt
.venv/bin/python scripts/setup-fire-model.py
if [[ ! -f .env ]]; then
  node --input-type=module - <<'JS'
import { readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
let text = readFileSync('.env.example', 'utf8');
for (const name of ['INGEST_TOKEN', 'DASHBOARD_TOKEN']) {
  text = text.replace(new RegExp(`^${name}=$`, 'm'), `${name}=${randomBytes(32).toString('hex')}`);
}
writeFileSync('.env', text, { mode: 0o600, flag: 'wx' });
JS
fi
mkdir -p "$HOME/.ssh"
chmod 700 "$HOME/.ssh"
if [[ ! -f "$HOME/.ssh/emberwatch_pi_ed25519" ]]; then
  ssh-keygen -q -t ed25519 -N '' -C "emberwatch-$(id -un)-mac" -f "$HOME/.ssh/emberwatch_pi_ed25519"
fi
echo 'Mac dependencies ready. Existing .env settings were preserved.'
echo 'Next: .venv/bin/python scripts/mac.py doctor'
