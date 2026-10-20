import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MenuStore } from '../server/sync.js';
import { externalMenu, ORG } from './fixtures.js';

test('MenuStore: синхронизация, новая версия при смене цены, кеш при недоступности iiko', async (t) => {
  let price = 420;
  let down = false;
  const calls = [];
  const fake = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    calls.push(req.url);
    if (down) { res.writeHead(503); return res.end('{}'); }
    const send = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.url === '/img/cake.jpg') { res.writeHead(200); return res.end('JPEG'); }
    if (req.url === '/api/1/access_token') return send({ token: 'tkn' });
    assert.equal(req.headers.authorization, 'Bearer tkn');
    if (req.url === '/api/1/organizations') return send({ organizations: [{ id: ORG, name: 'Madi Cake' }] });
    if (req.url === '/api/2/menu') return send({ externalMenus: [{ id: 'menu-1', name: 'Madi Cake' }], priceCategories: [] });
    if (req.url === '/api/2/menu/by_id') {
      assert.equal(JSON.parse(body).externalMenuId, 'menu-1');
      const m = externalMenu(price);
      m.itemCategories[0].items[0].itemSizes[0].buttonImageUrl = `http://127.0.0.1:${fake.address().port}/img/cake.jpg`;
      return send(m);
    }
    res.writeHead(404); res.end('{}');
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  const dataDir = await mkdtemp(path.join(tmpdir(), 'restohub-'));
  t.after(async () => { fake.close(); await rm(dataDir, { recursive: true, force: true }); });

  const cfg = {
    demo: false, dataDir, cacheImages: true, restaurantName: 'Madi Cake', currency: '₽', idleSeconds: 90, syncIntervalMin: 60,
    iiko: { apiLogin: 'key', apiUrl: `http://127.0.0.1:${fake.address().port}`, organizationName: 'Madi Cake', externalMenuName: 'Madi Cake' },
  };
  const store = new MenuStore(cfg);
  await store.init();
  clearInterval(store.timer);

  const v1 = store.menu.version;
  const item = store.menu.categories[0].items[0];
  assert.equal(item.price, 420);
  assert.match(item.image, /^\/media\/[0-9a-f]+\.jpg$/, 'фото скачано локально');
  assert.equal(await readFile(path.join(dataDir, 'media', path.basename(item.image)), 'utf8'), 'JPEG');

  let updated = 0;
  store.on('updated', () => updated++);
  await store.sync();
  assert.equal(updated, 0, 'без изменений версия та же');

  price = 450;
  await store.sync();
  assert.equal(updated, 1);
  assert.notEqual(store.menu.version, v1);
  assert.equal(store.menu.categories[0].items[0].price, 450);

  down = true;
  await store.sync();
  assert.ok(store.status.lastError);
  assert.equal(store.menu.categories[0].items[0].price, 450, 'при сбое отдаём последнее меню');

  const reloaded = new MenuStore(cfg);
  reloaded.sync = async () => reloaded.menu; // без сети: только диск
  await reloaded.init();
  clearInterval(reloaded.timer);
  assert.equal(reloaded.menu.version, store.menu.version, 'меню восстановлено с диска после перезапуска');
});
