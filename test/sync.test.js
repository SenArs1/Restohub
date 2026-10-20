import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { IikoSync } from '../server/sync.js';
import { startFakeIiko, testConfig } from './fake-iiko.js';

test('IikoSync: снимок, сверка цен, стоп-лист, кеш при недоступности iiko', async (t) => {
  const iiko = await startFakeIiko(t);
  const dataDir = await mkdtemp(path.join(tmpdir(), 'restohub-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const cfg = testConfig(dataDir, iiko.url);

  const sync = new IikoSync(cfg);
  await sync.init();
  sync.stop();

  const v1 = sync.snapshot.version;
  const item = sync.snapshot.content.categories[0].items[0];
  assert.equal(item.price, 420);
  assert.match(item.image, /^\/media\/[0-9a-f]+\.jpg$/, 'фото iiko скачано локально');
  assert.equal(await readFile(path.join(dataDir, 'media', path.basename(item.image)), 'utf8'), 'JPEG');
  assert.deepEqual(sync.status.priceCheck.mismatches, [], 'цены совпадают');
  assert.deepEqual(sync.stopList, []);

  iiko.state.nomPrice = 450; // цену поменяли в iiko, внешнее меню не обновили
  await sync.sync();
  assert.deepEqual(sync.status.priceCheck.mismatches.map((m) => [m.name, m.iikoPrice, m.menuPrice]), [['Медовик', 450, 420]]);

  let snapshots = 0;
  let stops = 0;
  sync.on('snapshot', () => snapshots++);
  sync.on('stoplist', () => stops++);
  await sync.sync();
  assert.equal(snapshots, 0, 'без изменений снимок тот же');

  iiko.state.price = 450;
  await sync.sync();
  assert.equal(snapshots, 1);
  assert.notEqual(sync.snapshot.version, v1);
  assert.deepEqual(sync.status.priceCheck.mismatches, [], 'после обновления внешнего меню расхождений нет');

  iiko.state.stop = ['p-1'];
  await sync.refreshStopList();
  await sync.refreshStopList();
  assert.deepEqual(sync.stopList, ['p-1:']);
  assert.equal(stops, 1, 'событие только при изменении');

  iiko.state.down = true;
  await sync.sync();
  await sync.refreshStopList();
  assert.ok(sync.status.lastError);
  assert.ok(sync.status.stopList.error);
  assert.equal(sync.snapshot.content.categories[0].items[0].price, 450, 'при сбое остаётся последний снимок');
  assert.deepEqual(sync.stopList, ['p-1:'], 'и последний стоп-лист');

  const reloaded = new IikoSync(cfg);
  await reloaded.init();
  reloaded.stop();
  assert.equal(reloaded.snapshot.version, sync.snapshot.version, 'снимок восстановлен с диска после перезапуска');
});
