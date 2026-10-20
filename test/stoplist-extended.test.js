import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { composeMenu } from '../server/compose.js';
import { parseStopList, stopListGroups } from '../server/stoplist.js';
import { IikoSync } from '../server/sync.js';
import { startFakeIiko, testConfig } from './fake-iiko.js';

const item = (id, extra = {}) => ({
  id, sku: null, sizeId: null, name: id, description: '', image: null, price: 100, weight: 100,
  unit: 'г', nutrition: null, sizes: [], allergens: [], tags: [], ...extra,
});
const cake = item('cake', { sizes: [
  { sizeId: 'piece', name: 'Кусочек', price: 420, weight: 150 },
  { sizeId: 'whole', name: 'Целый', price: 3900, weight: 1500 },
] });
const snapshot = { name: 'm', categories: [{ id: 'c', name: 'Торты', items: [item('eclair'), item('tart', { sizeId: 'std' }), cake] }] };
const state = (stopList) => Object.fromEntries(
  composeMenu({ snapshot, stopList }).categories[0].items.map((i) => [i.id, [i.soldOut, ...i.sizes.map((s) => s.soldOut)]]),
);

test('стоп-лист и размеры: товар целиком, конкретный размер, один размер с sizeId', () => {
  assert.deepEqual(state([]), { eclair: [false], tart: [false], cake: [false, false, false] });
  // Блюдо с одним размером: iiko может прислать sizeId шкалы, которого нет во внешнем меню.
  assert.deepEqual(state(['eclair:some-scale-size']).eclair, [true]);
  assert.deepEqual(state(['tart:std']).tart, [true]);
  assert.deepEqual(state(['tart:']).tart, [true]);
  // Несколько размеров: стоп только по одному размеру.
  assert.deepEqual(state(['cake:whole']).cake, [false, false, true]);
  // Стоп на товар целиком останавливает все размеры.
  assert.deepEqual(state(['cake:']).cake, [true, true, true]);
  // Все размеры по отдельности → блюдо закончилось.
  assert.deepEqual(state(['cake:piece', 'cake:whole']).cake, [true, true, true]);
  // Неизвестный размер и товар не из меню ничего не ломают.
  assert.deepEqual(state(['cake:unknown', 'ghost:']), { eclair: [false], tart: [false], cake: [false, false, false] });
});

test('разбор стоп-листа: остаток, отсутствие balance, группы терминалов', () => {
  const raw = { terminalGroupStopLists: [{ organizationId: 'o', items: [
    { terminalGroupId: 'hall', items: [
      { productId: 'a', balance: 0 }, { productId: 'b', balance: 3 }, { productId: 'c' }, { productId: 'd', sizeId: 's', balance: -2 },
    ] },
    { terminalGroupId: 'terrace', items: [{ productId: 'e', balance: 0 }] },
  ] }] };
  assert.deepEqual(parseStopList(raw), ['a:', 'd:s', 'e:']);
  assert.deepEqual(parseStopList(raw, { terminalGroupId: 'hall' }), ['a:', 'd:s']);
  assert.deepEqual(parseStopList(raw, { terminalGroupId: 'nope' }), []);
  assert.deepEqual(stopListGroups(raw), ['hall', 'terrace']);
  assert.deepEqual(parseStopList({}), []);
});

async function syncWith(t, cfgPatch = {}) {
  const iiko = await startFakeIiko(t);
  const dataDir = await mkdtemp(path.join(tmpdir(), 'restohub-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const cfg = testConfig(dataDir, iiko.url);
  const s = new IikoSync({ ...cfg, iiko: { ...cfg.iiko, ...cfgPatch } });
  await s.init();
  s.stop();
  return { iiko, s };
}

test('IikoSync: выбранная группа терминалов и несколько групп без выбора', async (t) => {
  const { iiko, s } = await syncWith(t, { terminalGroupId: 'hall' });
  iiko.state.stop = [{ productId: 'p-1', terminalGroupId: 'terrace' }, { productId: 'x', terminalGroupId: 'hall' }];
  await s.refreshStopList();
  assert.deepEqual(s.stopList, ['x:'], 'стоп другой точки не влияет');
  assert.deepEqual(s.status.stopList.groups, ['hall', 'terrace']);

  const other = await syncWith(t);
  other.iiko.state.stop = [{ productId: 'p-1', terminalGroupId: 'terrace' }, { productId: 'x', terminalGroupId: 'hall' }];
  await other.s.refreshStopList();
  assert.deepEqual(other.s.stopList, ['p-1:', 'x:'], 'без выбора — объединение всех групп');
});

test('IikoSync: потеря соединения сохраняет последний стоп-лист и время последнего успеха', async (t) => {
  const { iiko, s } = await syncWith(t);
  iiko.state.stop = ['p-1'];
  await s.refreshStopList();
  const ok = s.status.stopList.lastSuccessAt;
  let events = 0;
  s.on('stoplist', () => events++);

  // iiko перестал отвечать (соединение отклонено).
  s.client.apiUrl = 'http://127.0.0.1:9';
  await s.refreshStopList();
  assert.deepEqual(s.stopList, ['p-1:']);
  assert.equal(s.status.stopList.lastSuccessAt, ok);
  assert.match(s.status.stopList.error, /fetch failed/);
  assert.equal(events, 0);

  // Связь вернулась, позиция снова в продаже.
  s.client.apiUrl = iiko.url;
  iiko.state.stop = [];
  await s.refreshStopList();
  assert.deepEqual(s.stopList, []);
  assert.equal(s.status.stopList.error, null);
  assert.equal(events, 1);
});
