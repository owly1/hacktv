// Shared macOS/Windows/Linux launcher. No drone connection or flight commands.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
export function options(argv, env = process.env) {
  let port = Number(env.PORT || 8787), open = true;
  let live = false;
  for (let i = 0; i < argv.length; i++) {
    if (['--port', '-Port'].includes(argv[i])) port = Number(argv[++i]);
    else if (argv[i] === '--no-open') open = false;
    else if (argv[i] === '--live') live = true;
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be 1–65535');
  return { port, open, ...(live ? {live: true} : {}) };
}
export async function probe(base, fetchImpl = fetch, assets = []) {
  try { await fetchImpl(base, { signal: AbortSignal.timeout(1500) }); }
  catch { return false; }
  // Older backends expose demo analysis too, but lack the rescue-leads API.
  // Both requests must stop at authentication, before simulation or inference.
  for (const [route, method] of [['/api/demo/analyze', 'POST'], ['/api/demo/people', 'GET']]) {
    const response = await fetchImpl(base + route, {method, signal: AbortSignal.timeout(1500)});
    if (response.status !== 401) throw new Error('This port is occupied by an older or incompatible backend (the people demo is required). Stop it or use --port 9000 (PowerShell: .\\demo.ps1 -Port 9000).');
  }
  // A healthy process may serve another checkout, or an old STATIC_DIR.
  // Compare the actual dashboard files before reusing it.
  for (const [route, expected] of assets) {
    const response = await fetchImpl(base + route, {signal: AbortSignal.timeout(1500), cache: 'no-store'});
    if (!response.ok || await response.text() !== expected) {
      throw new Error(`The backend at ${base} is serving dashboard files from a different or outdated checkout (${route}). Stop that backend and rerun this launcher, or use --port 9000 (PowerShell: .\\demo.ps1 -Port 9000).`);
    }
  }
  return true;
}
function openBrowser(url) {
  const [command, args] = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]]
    : ['xdg-open', [url]];
  const child = spawn(command, args, { stdio: 'ignore', detached: true });
  child.on('error', () => console.log(`Open ${url} in your browser.`));
  child.unref();
}
export async function main() {
  process.chdir(root);
  if (!existsSync('.env')) throw new Error('Missing .env: copy .env.example and configure distinct ingest and dashboard tokens.');
  process.loadEnvFile('.env');
  const { port, open, live } = options(process.argv.slice(2));
  const base = `http://127.0.0.1:${port}`, url = `${base}/?${live ? 'live-demo' : 'demo'}`;
  const assets = await Promise.all(['index.html', 'app.js', 'people.js', 'demo-scout.js', 'sim-camera.js', 'styles.css',
    'bosco.js', 'bosco/tokens.css', 'bosco/dashboard.css', 'bosco/dashboard.js', 'bosco/theme.js',
    'bosco/mark.js', 'bosco/mark.css', 'bosco/transition.js', 'bosco/transition.css'].map(async name =>
    [name === 'index.html' ? '/' : '/' + name, await readFile(path.join(root, 'dist', name), 'utf8')]));
  const ready = () => probe(base, fetch, assets);
  if (await ready()) {
    console.log(`Emberwatch is already running: ${url}`);
    if (open) openBrowser(url);
    return;
  }
  const child = spawn(process.execPath, ['--env-file=.env', 'backend/server.mjs'], {
    cwd: root, stdio: 'inherit', env: { ...process.env, PORT: String(port), HOST: '127.0.0.1',
      ALLOWED_ORIGINS: [base, `http://localhost:${port}`, process.env.ALLOWED_ORIGINS].filter(Boolean).join(',') },
  });
  let exited = false;
  child.on('exit', code => { exited = true; process.exitCode = code ?? 1; });
  child.on('error', error => { exited = true; console.error(error.message); process.exitCode = 1; });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
    if (!exited) child.kill(signal);
  });
  console.log(`Starting Emberwatch demo: ${url} (Ctrl+C to stop)`);
  try {
    for (let i = 0; i < 60 && !exited; i++) {
      if (await ready()) { if (open) openBrowser(url); return; }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    if (!exited) throw new Error('Backend did not become ready within 30 seconds.');
  } catch (error) {
    if (!exited) child.kill();
    throw error;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
