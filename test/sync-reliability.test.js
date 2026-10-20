import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { IikoSync } from '../server/sync.js';
import { health } from '../server/health.js';
import { startFakeIiko, testConfig } from './fake-iiko.js';

async function setup(t) {
  const iiko = await startFakeIiko(t);
  const dataDir = await mkdtemp(path.join(tmpdir(), 'restohub-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const cfg = testConfig(dataDir, iiko.url);
  const make = async () => {
    const s = new IikoSync(cfg);
    await s.init();
    s.stop();
    return s;
  };
  return { iiko, dataDir, cfg, make };
}

const items = (s) => s.snapshot.content.categories.flatMap((c) => c.items).length;

test('время последней успешной синхронизации переживает перезапуск, даже если меню не менялось', async (t) => {
  const { make } = await setup(t);
  const a = await make();
  const changedAt = a.snapshot.fetchedAt;
  await new Promise((r) => setTimeout(r, 15));
  await a.sync();
  assert.equal(a.snapshot.fetchedAt, changedAt, 'меню не менялось');
  assert.ok(a.status.lastSuccessAt > changedAt);
  const checked = a.status.lastSuccessAt;

  const b = new IikoSync(a.config);
  b.sync = async () => b.snapshot; // без сети
  b.refreshStopList = async () => [];
  await b.init();
  b.stop();
  assert.equal(b.status.lastSuccessAt, checked, 'после перезапуска — время последней проверки, а не последнего изменения');
});

test('сбои iiko не теряют рабочее меню: 503, пустое меню, нет соединения, повреждённый снимок', async (t) => {
  const { iiko, dataDir, cfg, make } = await setup(t);
  const s = await make();
  const v1 = s.snapshot.version;

  iiko.state.down = true; // 503
  await s.sync();
  assert.equal(s.snapshot.version, v1);
  assert.ok(s.status.lastError);

  iiko.state.down = false;
  iiko.state.empty = true; // iiko вернул внешнее меню без категорий
  await s.sync();
  assert.equal(s.snapshot.version, v1);
  assert.match(s.status.lastError, /пустое/);

  iiko.state.empty = false;
  iiko.state.price = 450; // меню снова корректное и изменилось → предыдущее сохраняется как запасное
  await s.sync();
  assert.notEqual(s.snapshot.version, v1);
  assert.equal(s.status.lastError, null);
  const prev = JSON.parse(await readFile(path.join(dataDir, 'iiko-snapshot.prev.json'), 'utf8'));
  assert.equal(prev.version, v1);

  // Основной снимок повреждён (например, диск переполнился при записи), iiko недоступен.
  await writeFile(path.join(dataDir, 'iiko-snapshot.json'), '{"version": "abc", "conte');
  const offline = new IikoSync({ ...cfg, iiko: { ...cfg.iiko, apiUrl: 'http://127.0.0.1:9' } });
  await offline.init();
  offline.stop();
  assert.equal(offline.snapshot.version, v1, 'загружен запасной снимок');
  assert.match(offline.status.lastError, /fetch failed|ECONNREFUSED/i);
  assert.ok(offline.status.stopList.error, 'стоп-лист тоже недоступен');
});

test('защита от резкого сокращения меню: удержание и подтверждение', async (t) => {
  const { iiko, make } = await setup(t);
  iiko.state.extraItems = 15;
  const s = await make();
  assert.equal(items(s), 16);
  const v = s.snapshot.version;
  let events = 0;
  s.on('snapshot', () => events++);

  iiko.state.extraItems = 0; // iiko вдруг прислал 1 блюдо вместо 16
  await s.sync();
  assert.equal(s.snapshot.version, v, 'планшеты остаются на прежнем меню');
  assert.equal(events, 0);
  assert.deepEqual([s.status.held.count, s.status.held.prevCount], [1, 16]);
  assert.match(s.status.lastError, /1 блюдами вместо 16/);
  assert.equal(health(s.status, s.config).warnings[0].code, 'held');

  assert.equal(await s.acceptHeld(), true);
  assert.equal(items(s), 1);
  assert.equal(events, 1);
  assert.equal(s.status.held, null);

  // Небольшие изменения проходят без удержания.
  iiko.state.extraItems = 15;
  await s.sync();
  iiko.state.extraItems = 12;
  await s.sync();
  assert.equal(items(s), 13);
  assert.equal(s.status.held, null);
});

test('удержанное меню сбрасывается, если iiko снова прислал нормальное', async (t) => {
  const { iiko, make } = await setup(t);
  iiko.state.extraItems = 15;
  const s = await make();
  iiko.state.extraItems = 0;
  await s.sync();
  assert.ok(s.status.held);
  iiko.state.extraItems = 15;
  await s.sync();
  assert.equal(s.status.held, null);
  assert.equal(s.status.lastError, null);
});

test('фото iiko: HTML вместо картинки не сохраняется', async (t) => {
  const { iiko, make } = await setup(t);
  iiko.state.imagePath = '/img/error-page';
  const s = await make();
  assert.match(s.snapshot.content.categories[0].items[0].image, /^http:.*error-page$/, 'осталась исходная ссылка');
});

test('свежесть данных и предупреждения', () => {
  const cfg = { syncIntervalMin: 5, stopListIntervalSec: 60, iiko: {} };
  const now = Date.parse('2026-10-20T12:00:00Z');
  const ago = (min) => new Date(now - min * 60000).toISOString();
  const ok = { source: 'iiko', lastSuccessAt: ago(4), stopList: { lastSuccessAt: ago(1), groups: ['tg'] }, priceCheck: { mismatches: [] } };
  assert.deepEqual(health(ok, cfg, now).warnings, []);

  const stale = { ...ok, lastSuccessAt: ago(40), lastError: 'fetch failed' };
  const h = health(stale, cfg, now);
  assert.equal(h.menu.stale, true);
  assert.deepEqual(h.warnings.map((w) => [w.code, w.level]), [['menu_stale', 'error'], ['iiko_error', 'error']]);

  const fresh = health({ ...ok, lastError: 'временный сбой' }, cfg, now);
  assert.deepEqual(fresh.warnings.map((w) => [w.code, w.level]), [['iiko_error', 'warn']], 'свежие данные — только предупреждение');

  const prices = health({ ...ok, priceCheck: { mismatches: [{}, {}] } }, cfg, now);
  assert.equal(prices.warnings[0].code, 'price_mismatch');
  assert.match(prices.warnings[0].text, /у 2 блюд/);

  const groups = health({ ...ok, stopList: { ...ok.stopList, groups: ['a', 'b'] } }, cfg, now);
  assert.equal(groups.warnings[0].code, 'terminal_groups');
  assert.deepEqual(health({ ...ok, stopList: { ...ok.stopList, groups: ['a', 'b'] } }, { ...cfg, iiko: { terminalGroupId: 'a' } }, now).warnings, []);

  const stopDown = health({ ...ok, stopList: { lastSuccessAt: ago(30), error: 'fetch failed', groups: [] } }, cfg, now);
  assert.deepEqual(stopDown.warnings.map((w) => [w.code, w.level]), [['stoplist_error', 'error']]);

  assert.equal(health({ source: 'iiko', lastSuccessAt: null }, cfg, now).warnings[0].code, 'no_menu');
  assert.deepEqual(health({ source: 'demo' }, cfg, now).warnings, []);
});
