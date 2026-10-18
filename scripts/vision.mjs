// Laptop inference only. The Pi observer supplies video and telemetry separately.
import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const localPython = path.join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const python = process.env.PYTHON || (existsSync(localPython) ? localPython : process.platform === 'win32' ? 'python' : 'python3');
if (!process.env.INGEST_TOKEN || !process.env.DASHBOARD_TOKEN) {
  throw new Error('Configure INGEST_TOKEN and DASHBOARD_TOKEN in .env before starting vision.');
}
const child = spawn(python, ['-u', path.join(root, 'bridge/fire_monitor.py'),
  '--backend', `http://127.0.0.1:${process.env.PORT || 8787}`, ...process.argv.slice(2)],
  {cwd: root, stdio: 'inherit', env: process.env});
child.on('error', error => {console.error(error.message); process.exitCode = 1;});
child.on('exit', code => {process.exitCode = code ?? 1;});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {if (child.exitCode === null) child.kill(signal);});
