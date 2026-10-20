// Общие функции E2E: запуск сервера Restohub отдельным процессом и клиент API админки.
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import sharp from 'sharp';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export function createUser(dataDir, login, role, password) {
  execFileSync(process.execPath, ['scripts/admin-user.js', login, role, `--password=${password}`], {
    cwd: ROOT, env: { ...process.env, DATA_DIR: dataDir, NODE_NO_WARNINGS: '1' }, stdio: 'ignore',
  });
}

/** Запускает сервер и ждёт, пока он ответит. env дополняет окружение (DEMO, DATA_DIR, …). */
export async function startServer({ port, env }) {
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', BACKUP_INTERVAL_HOURS: '0', NODE_NO_WARNINGS: '1', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  const base = `http://localhost:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${base}/api/status`)).ok) return { child, base, log: () => log };
    } catch { /* ещё не поднялся */ }
    if (child.exitCode !== null) throw new Error(`Сервер не запустился:\n${log}`);
    await new Promise((r) => setTimeout(r, 200));
  }
  child.kill();
  throw new Error(`Сервер не ответил:\n${log}`);
}

export async function stopServer(server) {
  if (!server || server.child.exitCode !== null) return;
  const done = new Promise((r) => server.child.once('exit', r));
  server.child.kill('SIGTERM');
  await done;
}

/** Клиент API админки с cookie-сессией. */
export function adminClient(base) {
  let cookie = '';
  const api = async (method, p, body, headers = {}) => {
    const isFile = body instanceof Uint8Array;
    const res = await fetch(base + p, {
      method,
      headers: {
        ...(cookie ? { Cookie: cookie } : {}),
        ...(method !== 'GET' ? { 'X-Requested-With': 'restohub' } : {}),
        ...(body !== undefined && !isFile ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : isFile ? body : JSON.stringify(body),
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`${method} ${p}: ${res.status} ${data?.error ?? ''}`);
    return data;
  };
  api.login = (login, password) => api('POST', '/api/admin/login', { login, password });
  api.upload = async (color, label) => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1800" height="1350"><rect width="100%" height="100%" fill="${color}"/>`
      + `<text x="900" y="700" font-size="160" text-anchor="middle" fill="#fff" font-family="Georgia">${label}</text></svg>`;
    const jpeg = await sharp(Buffer.from(svg)).jpeg({ quality: 85 }).toBuffer();
    return (await api('POST', '/api/admin/media', jpeg, { 'Content-Type': 'image/jpeg' })).media;
  };
  return api;
}

export function check(cond, message) {
  if (!cond) throw new Error(`ПРОВАЛ: ${message}`);
  console.log(`  ✓ ${message}`);
}
