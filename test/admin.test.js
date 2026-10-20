import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { openDb } from '../server/db.js';
import { Auth } from '../server/auth.js';
import { ContentStore } from '../server/content.js';
import { IikoSync } from '../server/sync.js';
import { Publisher } from '../server/publisher.js';
import { createApp } from '../server/app.js';
import { startFakeIiko, testConfig } from './fake-iiko.js';

async function startRestohub(t) {
  const iiko = await startFakeIiko(t);
  const dataDir = await mkdtemp(path.join(tmpdir(), 'restohub-'));
  const config = testConfig(dataDir, iiko.url);
  const db = openDb(':memory:');
  const auth = new Auth(db);
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
    await rm(dataDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
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
    if (setCookie) cookie = setCookie.split(';')[0];
    return { status: res.status, body: await res.json().catch(() => null), headers: res.headers };
  };
  return { iiko, sync, api, dataDir, logout: () => { cookie = ''; } };
}

const menuItem = async (api, preview = false) => (await api('GET', `/api/menu${preview ? '?preview=1' : ''}`)).body.categories[0].items[0];

test('админка: вход, правка, фото, предпросмотр, публикация, стоп-лист, откат', async (t) => {
  const { iiko, sync, api, dataDir, logout } = await startRestohub(t);

  // Без входа — нельзя.
  assert.equal((await api('GET', '/api/admin/state')).status, 401);
  assert.equal((await api('GET', '/api/menu?preview=1')).status, 401);
  assert.equal((await api('POST', '/api/admin/login', { login: 'anna', password: 'wrong-password' })).status, 401);

  const login = await api('POST', '/api/admin/login', { login: 'Anna', password: 'correct-horse-battery' });
  assert.equal(login.status, 200);
  assert.match(login.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  const state = (await api('GET', '/api/admin/state')).body;
  assert.equal(state.user.login, 'anna');
  assert.equal(state.iiko[0].items[0].id, 'p-1');

  // Изменения без заголовка X-Requested-With отклоняются (CSRF).
  assert.equal((await api('PATCH', '/api/admin/items/p-1', { title: 'x' }, { 'X-Requested-With': '' })).status, 403);

  // Фото: загрузка и обработка.
  const jpeg = await sharp({ create: { width: 2400, height: 1800, channels: 3, background: '#c9786f' } }).jpeg().toBuffer();
  const up = await api('POST', '/api/admin/media', jpeg, { 'Content-Type': 'image/jpeg', 'X-Filename': encodeURIComponent('медовик.jpg') });
  assert.equal(up.status, 200);
  const photo = up.body.media;
  assert.ok((await stat(path.join(dataDir, 'media', `${photo.id}-1600.webp`))).size > 0);
  assert.equal((await api('POST', '/api/admin/media', Buffer.from('<svg/>'), { 'Content-Type': 'image/svg+xml' })).status, 400);

  // Правка черновика не видна планшетам, но видна в предпросмотре.
  const patch = await api('PATCH', '/api/admin/items/p-1', { title: 'Медовик «Мади»', photos: [photo.id], badges: ['Хит'] });
  assert.equal(patch.status, 200);
  assert.equal((await api('PATCH', '/api/admin/items/p-1', { badges: ['Самое вкусное'] })).status, 400);
  assert.equal((await menuItem(api)).name, 'Медовик');
  const preview = await menuItem(api, true);
  assert.equal(preview.name, 'Медовик «Мади»');
  assert.equal(preview.image, `/media/${photo.id}-800.jpg`);
  assert.deepEqual((await api('GET', '/api/admin/state')).body.changes, [{ kind: 'item', id: 'p-1' }]);

  // Публикация → планшеты видят новое, версия меняется.
  const v0 = (await api('GET', '/api/menu')).body.version;
  const pub = await api('POST', '/api/admin/publish', { note: 'Фото медовика' });
  assert.equal(pub.status, 200);
  const published = await menuItem(api);
  assert.equal(published.name, 'Медовик «Мади»');
  assert.equal(published.price, 420, 'цена из iiko');
  assert.deepEqual(published.tags.slice(0, 1), ['Хит']);
  assert.notEqual(pub.body.version, v0);
  assert.deepEqual((await api('GET', '/api/admin/state')).body.changes, []);

  // Стоп-лист из iiko применяется сразу, без публикации.
  iiko.state.stop = ['p-1'];
  await sync.refreshStopList();
  assert.equal((await menuItem(api)).soldOut, true);
  await api('PATCH', '/api/admin/settings', { soldOutMode: 'hide' });
  await api('POST', '/api/admin/publish', {});
  assert.equal((await api('GET', '/api/menu')).body.categories.length, 0, 'закончившееся скрыто');

  // Откат к первой публикации.
  const restore = await api('POST', `/api/admin/publications/${pub.body.publication}/restore`);
  assert.equal(restore.status, 200);
  assert.equal((await menuItem(api)).soldOut, true, 'снова режим «Закончилось»');

  // Выход: сессия больше не действует.
  await api('POST', '/api/admin/logout');
  assert.equal((await api('GET', '/api/admin/state')).status, 401);
  logout();
});

test('админка: лимит попыток входа', async (t) => {
  const { api } = await startRestohub(t);
  for (let i = 0; i < 10; i++) await api('POST', '/api/admin/login', { login: 'anna', password: `wrong-${i}-password` });
  const blocked = await api('POST', '/api/admin/login', { login: 'anna', password: 'correct-horse-battery' });
  assert.equal(blocked.status, 429, 'даже верный пароль после 10 ошибок');
});
