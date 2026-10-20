import test from 'node:test';
import assert from 'node:assert/strict';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { startRestohub } from './restohub-stand.js';

const menuItem = async (api, preview = false) => (await api('GET', `/api/menu${preview ? '?preview=1' : ''}`)).body.categories[0].items[0];

test('админка: вход, правка, фото, предпросмотр, публикация, стоп-лист, откат', async (t) => {
  const { iiko, sync, api, dataDir, logout } = await startRestohub(t);

  // Без входа — нельзя.
  assert.equal((await api('GET', '/api/admin/state')).status, 401);
  assert.equal((await api('GET', '/api/menu?preview=1')).status, 401);
  assert.equal((await api('POST', '/api/admin/login', { login: 'anna', password: 'wrong-password' })).status, 401);

  const login = await api('POST', '/api/admin/login', { login: 'Olga', password: 'owner-password-123' });
  assert.equal(login.status, 200);
  assert.match(login.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  const state = (await api('GET', '/api/admin/state')).body;
  assert.equal(state.user.login, 'olga');
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
