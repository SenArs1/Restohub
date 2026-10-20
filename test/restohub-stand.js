// Полный сервер Restohub поверх фейкового iiko для интеграционных тестов.
// Пользователи: olga (owner, owner-password-123), anna (manager, correct-horse-battery).
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDb } from '../server/db.js';
import { Auth } from '../server/auth.js';
import { ContentStore } from '../server/content.js';
import { IikoSync } from '../server/sync.js';
import { Publisher } from '../server/publisher.js';
import { createApp } from '../server/app.js';
import { startFakeIiko, testConfig } from './fake-iiko.js';

export async function startRestohub(t, configPatch = {}) {
  const iiko = await startFakeIiko(t);
  const dataDir = await mkdtemp(path.join(tmpdir(), 'restohub-'));
  const config = { ...testConfig(dataDir, iiko.url), ...configPatch };
  const db = openDb(path.join(dataDir, 'restohub.db'));
  const auth = new Auth(db, { idleHours: config.sessionIdleHours ?? 24 });
  await auth.upsertUser('olga', 'owner-password-123', 'owner');
  await auth.upsertUser('anna', 'correct-horse-battery', 'manager');
  const content = new ContentStore(db);
  const sync = new IikoSync(config);
  const publisher = new Publisher({ config, sync, content });
  const server = createApp({ config, sync, content, auth, publisher });
  await sync.init();
  sync.stop();
  publisher.rebuild();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(async () => {
    server.closeAllConnections();
    server.close();
    db.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  /** Клиент со своей cookie-сессией: как отдельный браузер. */
  const client = () => {
    let cookie = '';
    const api = async (method, p, body, headers = {}) => {
      const isJson = body !== undefined && !(body instanceof Uint8Array);
      const res = await fetch(base + p, {
        method,
        headers: {
          ...(cookie ? { Cookie: cookie } : {}),
          ...(method !== 'GET' ? { 'X-Requested-With': 'restohub' } : {}),
          ...(isJson ? { 'Content-Type': 'application/json' } : {}),
          ...headers,
        },
        body: isJson ? JSON.stringify(body) : body,
      });
      const setCookie = res.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0].endsWith('=') ? '' : setCookie.split(';')[0];
      return { status: res.status, body: await res.json().catch(() => null), headers: res.headers };
    };
    api.login = (login, password) => api('POST', '/api/admin/login', { login, password });
    api.cookie = () => cookie;
    return api;
  };

  const api = client();
  return { iiko, sync, db, auth, config, server, base, dataDir, api, client, logout: () => {} };
}
