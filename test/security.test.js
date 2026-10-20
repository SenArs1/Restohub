import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDb, SCHEMA_VERSION } from '../server/db.js';
import { startRestohub } from './restohub-stand.js';

/** Конкретный путь из шаблона маршрута: параметры заменяются тестовыми значениями. */
const samplePath = (pattern) => pattern
  .replace(/^\^|\$$/g, '')
  .replaceAll('\\/', '/')
  .replaceAll('([^/]+)', 'nobody')
  .replaceAll('(\\d+)', '999999');

test('все маршруты админки: без входа 401, без X-Requested-With и с чужого сайта 403, права владельца', async (t) => {
  const { server, client } = await startRestohub(t);
  const routes = server.routeTable;
  assert.ok(routes.length >= 15, 'таблица маршрутов получена');
  const anon = client();
  const manager = client();
  const owner = client();
  assert.equal((await manager.login('anna', 'correct-horse-battery')).status, 200);
  assert.equal((await owner.login('olga', 'owner-password-123')).status, 200);

  for (const r of routes) {
    const p = samplePath(r.pattern);
    const label = `${r.method} ${p}`;
    assert.equal((await anon(r.method, p, r.method === 'GET' ? undefined : {})).status, 401, `${label}: без входа`);
    if (r.method !== 'GET') {
      const noHeader = await manager(r.method, p, {}, { 'X-Requested-With': '' });
      assert.equal(noHeader.status, 403, `${label}: без X-Requested-With`);
      const evil = await manager(r.method, p, {}, { Origin: 'https://evil.example' });
      assert.equal(evil.status, 403, `${label}: чужой Origin`);
      const cross = await manager(r.method, p, {}, { 'Sec-Fetch-Site': 'cross-site' });
      assert.equal(cross.status, 403, `${label}: межсайтовый запрос`);
    }
    if (r.role === 'owner') {
      const m = await manager(r.method, p, r.method === 'GET' ? undefined : {});
      assert.equal(m.status, 403, `${label}: менеджеру запрещено`);
      assert.equal(m.body.error, 'Доступно только владельцу');
    }
    const o = await owner(r.method, p, r.method === 'GET' ? undefined : {});
    assert.notEqual(o.status, 401, `${label}: владелец вошёл`);
    assert.notEqual(o.body?.error, 'Доступно только владельцу', `${label}: владельцу разрешено`);
  }

  // Вход и выход тоже защищены от запросов с чужого сайта.
  assert.equal((await anon('POST', '/api/admin/login', { login: 'olga', password: 'owner-password-123' }, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await anon('GET', '/api/menu?preview=1')).status, 401);
});

test('права менеджера: контент и публикация — да, откат, настройки и пользователи — нет', async (t) => {
  const { server } = await startRestohub(t);
  const owners = server.routeTable.filter((r) => r.role === 'owner').map((r) => `${r.method} ${samplePath(r.pattern)}`);
  assert.deepEqual(owners.sort(), [
    'DELETE /api/admin/users/nobody',
    'GET /api/admin/users',
    'PATCH /api/admin/settings',
    'PATCH /api/admin/users/nobody',
    'POST /api/admin/iiko/accept-held',
    'POST /api/admin/publications/999999/restore',
    'POST /api/admin/users',
    'POST /api/admin/users/nobody/password',
    'GET /api/admin/maintenance/media',
    'POST /api/admin/maintenance/media/cleanup',
    'GET /api/admin/backups',
    'POST /api/admin/backups',
    'POST /api/admin/backups/nobody/verify',
  ].sort());
  const managers = server.routeTable.filter((r) => r.role === 'manager').map((r) => `${r.method} ${samplePath(r.pattern)}`);
  for (const r of ['PATCH /api/admin/items/nobody', 'POST /api/admin/media', 'POST /api/admin/publish', 'POST /api/admin/discard', 'POST /api/admin/sync']) {
    assert.ok(managers.includes(r), r);
  }
});

test('сессии: простой, срок действия, смена пароля, выход', async (t) => {
  const { client, db } = await startRestohub(t, { sessionIdleHours: 24 });
  const a = client();
  await a.login('anna', 'correct-horse-battery');
  assert.equal((await a('GET', '/api/admin/state')).status, 200);

  // Простой больше 24 часов.
  db.prepare("UPDATE sessions SET last_seen_at = '2000-01-01T00:00:00.000Z'").run();
  assert.equal((await a('GET', '/api/admin/state')).status, 401);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0, 'сессия удалена');

  // Истёк абсолютный срок.
  await a.login('anna', 'correct-horse-battery');
  db.prepare("UPDATE sessions SET expires_at = '2000-01-01T00:00:00.000Z'").run();
  assert.equal((await a('GET', '/api/admin/state')).status, 401);

  // Смена своего пароля завершает все сессии пользователя.
  await a.login('anna', 'correct-horse-battery');
  const b = client();
  await b.login('anna', 'correct-horse-battery');
  assert.equal((await a('POST', '/api/admin/me/password', { current: 'wrong-password', next: 'new-password-456' })).status, 403);
  assert.equal((await a('POST', '/api/admin/me/password', { current: 'correct-horse-battery', next: 'short' })).status, 400);
  assert.equal((await a('POST', '/api/admin/me/password', { current: 'correct-horse-battery', next: 'new-password-456' })).status, 200);
  assert.equal((await b('GET', '/api/admin/state')).status, 401, 'другие сессии завершены');
  assert.equal((await a.login('anna', 'correct-horse-battery')).status, 401);
  assert.equal((await a.login('anna', 'new-password-456')).status, 200);
  await a('POST', '/api/admin/logout');
  assert.equal((await a('GET', '/api/admin/state')).status, 401);
});

test('пользователи: создание, сброс пароля, роли, защита последнего владельца', async (t) => {
  const { client } = await startRestohub(t);
  const o = client();
  await o.login('olga', 'owner-password-123');
  const created = await o('POST', '/api/admin/users', { login: 'Kate', role: 'manager' });
  assert.equal(created.status, 200);
  assert.equal(created.body.login, 'kate');
  assert.ok(created.body.password.length >= 12);
  assert.equal((await o('POST', '/api/admin/users', { login: 'kate', role: 'manager' })).status, 409);
  assert.equal((await o('POST', '/api/admin/users', { login: 'x', role: 'manager' })).status, 400);

  const k = client();
  assert.equal((await k.login('kate', created.body.password)).status, 200);
  assert.equal((await k('GET', '/api/admin/users')).status, 403);

  const reset = await o('POST', '/api/admin/users/kate/password');
  assert.equal((await k('GET', '/api/admin/state')).status, 401, 'сброс пароля завершает сессии');
  assert.equal((await k.login('kate', reset.body.password)).status, 200);

  assert.equal((await o('PATCH', '/api/admin/users/olga', { role: 'manager' })).status, 400, 'свою роль не менять');
  assert.equal((await o('DELETE', '/api/admin/users/olga')).status, 400, 'себя не удалить');
  assert.equal((await o('PATCH', '/api/admin/users/kate', { role: 'owner' })).status, 200);
  // Теперь kate — владелец и может понизить olga, но не себя, если она последняя.
  await k.login('kate', reset.body.password);
  assert.equal((await k('PATCH', '/api/admin/users/olga', { role: 'manager' })).status, 200);
  assert.equal((await k('DELETE', '/api/admin/users/anna')).status, 200);
  const users = (await k('GET', '/api/admin/users')).body.users.map((u) => `${u.login}:${u.role}`);
  assert.deepEqual(users, ['kate:owner', 'olga:manager']);
});

test('HTTPS: Secure-cookie и HSTS за прокси, заголовки безопасности, CSP', async (t) => {
  const plain = await startRestohub(t);
  const r1 = await plain.api.login('olga', 'owner-password-123');
  assert.doesNotMatch(r1.headers.get('set-cookie'), /Secure/, 'по HTTP без Secure (иначе браузер не сохранит cookie)');
  // Без TRUST_PROXY заголовок X-Forwarded-Proto игнорируется.
  const spoofed = await plain.api('POST', '/api/admin/login', { login: 'olga', password: 'owner-password-123' }, { 'X-Forwarded-Proto': 'https' });
  assert.doesNotMatch(spoofed.headers.get('set-cookie'), /Secure/);

  const proxied = await startRestohub(t, { trustProxy: true });
  const r2 = await proxied.api('POST', '/api/admin/login', { login: 'olga', password: 'owner-password-123' }, { 'X-Forwarded-Proto': 'https' });
  assert.match(r2.headers.get('set-cookie'), /HttpOnly; SameSite=Strict; Max-Age=\d+; Secure/);
  assert.match(r2.headers.get('strict-transport-security'), /max-age=/);

  const forced = await startRestohub(t, { cookieSecure: true });
  assert.match((await forced.api.login('olga', 'owner-password-123')).headers.get('set-cookie'), /Secure/);

  const page = await fetch(`${plain.base}/`);
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(page.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'(;|$)/);
  const admin = await fetch(`${plain.base}/admin`);
  const html = readFileSync(new URL('../public/admin/index.html', import.meta.url), 'utf8');
  const importmap = html.match(/<script type="importmap">([\s\S]*?)<\/script>/)[1];
  const hash = createHash('sha256').update(importmap).digest('base64');
  assert.ok(admin.headers.get('content-security-policy').includes(`'sha256-${hash}'`), 'importmap разрешён по хешу');
  assert.equal(admin.headers.get('cache-control'), 'no-store');
  assert.equal((await plain.api('GET', '/api/admin/me')).headers.get('cache-control'), 'no-store');
});

test('лимит попыток входа: подмена X-Forwarded-For без TRUST_PROXY не помогает', async (t) => {
  const { client } = await startRestohub(t);
  const a = client();
  for (let i = 0; i < 10; i++) {
    await a('POST', '/api/admin/login', { login: `user${i}`, password: 'wrong-password' }, { 'X-Forwarded-For': `10.0.0.${i}` });
  }
  assert.equal((await a.login('olga', 'owner-password-123')).status, 429, 'IP один и тот же');
});

test('миграция базы P1 и отказ от базы более новой версии', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'restohub-db-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'p1.db');
  // База в формате P1: сессии без last_seen_at, user_version = 0.
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, login TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
              role TEXT NOT NULL CHECK (role IN ('owner', 'manager')), created_at TEXT NOT NULL);
            CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
              created_at TEXT NOT NULL, expires_at TEXT NOT NULL);
            INSERT INTO users VALUES (1, 'olga', 'x', 'owner', '2026-10-20T00:00:00Z');
            INSERT INTO sessions VALUES ('h', 1, '2026-10-20T10:00:00Z', '2026-11-03T10:00:00Z');`);
  old.close();

  const db = openDb(file);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
  assert.equal(db.prepare('SELECT last_seen_at FROM sessions').get().last_seen_at, '2026-10-20T10:00:00Z');
  assert.equal(db.prepare('SELECT login FROM users').get().login, 'olga', 'данные сохранены');
  db.exec('PRAGMA user_version = 99');
  db.close();
  assert.throws(() => openDb(file), /более новой версией/);
});

test('встроенный HTTPS: TLS_CERT_FILE/TLS_KEY_FILE, Secure-cookie и HSTS', async (t) => {
  const { execFileSync } = await import('node:child_process');
  const https = await import('node:https');
  const { createApp } = await import('../server/app.js');
  const dir = await mkdtemp(path.join(tmpdir(), 'restohub-tls-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
      '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem')], { stdio: 'ignore' });
  } catch {
    t.skip('openssl недоступен');
    return;
  }
  const stand = await startRestohub(t);
  const tls = { key: readFileSync(path.join(dir, 'key.pem')), cert: readFileSync(path.join(dir, 'cert.pem')) };
  const server = createApp({ config: stand.config, sync: stand.sync, content: { mediaIndex: () => new Map() }, auth: stand.auth, publisher: { on() {}, menu: null }, tls });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const body = JSON.stringify({ login: 'olga', password: 'owner-password-123' });
  const res = await new Promise((resolve, reject) => {
    const req = https.request({
      host: '127.0.0.1', port: server.address().port, path: '/api/admin/login', method: 'POST', rejectUnauthorized: false,
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'restohub', 'Content-Length': Buffer.byteLength(body) },
    }, resolve);
    req.on('error', reject);
    req.end(body);
  });
  res.resume();
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['set-cookie'][0], /; Secure$/);
  assert.match(res.headers['strict-transport-security'], /max-age=/);
});
