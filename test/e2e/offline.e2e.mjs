// E2E офлайн-режима планшета (Chromium, постоянный профиль как у браузера на планшете).
// Запуск: npm run e2e:offline
//
// 1. Планшет открывает меню онлайн → фото опубликованной версии предзагружаются.
// 2. Сервер полностью недоступен + браузер перезапущен → меню и все фото открываются из кеша.
// 3. Новая публикация → фото новой версии загружаются, фото прежней удаляются из кеша.
// 4. Загрузка новой версии оборвалась → фото рабочей версии в кеше сохраняются.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { adminClient, check, createUser, startServer, stopServer } from './helpers.mjs';

const PORT = 8190 + Math.floor(Math.random() * 100);
const dataDir = await mkdtemp(path.join(tmpdir(), 'rh-e2e-data-'));
const profile = await mkdtemp(path.join(tmpdir(), 'rh-e2e-profile-'));
const env = { DEMO: '1', DATA_DIR: dataDir };
let server;
let ctx;

const MEDIA_CACHE = 'restohub-media-v2';
const cachedUrls = (page) => page.evaluate(async (name) => (await (await caches.open(name)).keys()).map((r) => new URL(r.url).pathname), MEDIA_CACHE);
const precacheDone = (page, version) => page.waitForFunction((v) => {
  try {
    const s = JSON.parse(localStorage.getItem('restohub.precache'));
    return s && s.version === v && s.done + s.failed === s.total ? s : false;
  } catch { return false; }
}, version, { timeout: 30000 }).then((h) => h.jsonValue());
const brokenImages = (page) => page.$$eval('img.media', (imgs) => imgs.filter((i) => i.complete && i.naturalWidth === 0).map((i) => i.src));

try {
  createUser(dataDir, 'olga', 'owner', 'owner-password-123');
  server = await startServer({ port: PORT, env });
  const api = adminClient(server.base);
  await api.login('olga', 'owner-password-123');

  // Контент: фото у медовика (галерея из 2 фото) и у эклера.
  const [honey1, honey2, eclair] = [await api.upload('#b5655a', 'Медовик 1'), await api.upload('#8a4b3c', 'Медовик 2'), await api.upload('#d9a07a', 'Эклер')];
  await api('PATCH', '/api/admin/items/c1', { photos: [honey1.id, honey2.id] });
  await api('PATCH', '/api/admin/items/p2', { photos: [eclair.id] });
  await api('POST', '/api/admin/publish', { note: 'e2e v1' });
  const v1 = (await (await fetch(`${server.base}/api/menu`)).json()).version;

  console.log('1. Онлайн: предзагрузка фото опубликованной версии');
  ctx = await chromium.launchPersistentContext(profile, { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
  let page = ctx.pages()[0] ?? (await ctx.newPage());
  await page.goto(`${server.base}/?diag=1`);
  await page.waitForSelector('.card');
  const s1 = await precacheDone(page, v1);
  check(s1.complete && s1.total >= 5, `предзагружено ${s1.done}/${s1.total} фото версии ${v1}`);
  const urls1 = await cachedUrls(page);
  check([honey1, honey2, eclair].every((m) => urls1.some((u) => u.startsWith(`/media/${m.id}-`))), 'в кеше фото медовика (2) и эклера');
  check(urls1.some((u) => u.endsWith('-1600.webp')), 'на экране 2x крупное фото блюда берётся в копии 1600 px');
  await ctx.close();

  console.log('2. Полная потеря сети и перезапуск браузера');
  await stopServer(server);
  ctx = await chromium.launchPersistentContext(profile, { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, offline: true });
  page = ctx.pages()[0] ?? (await ctx.newPage());
  await page.goto(`${server.base}/?diag=1`);
  await page.waitForSelector('.card', { timeout: 15000 });
  check((await page.textContent('#status')).includes('нет связи'), 'меню открылось без сети, плашка «нет связи»');
  check(await page.$('.card[data-item="c1"] img.media') !== null, 'карточка медовика с фото');
  // Прокручиваем всё меню, чтобы загрузились и ленивые фото.
  await page.$eval('#content', (el) => el.scrollTo(0, el.scrollHeight));
  await page.waitForTimeout(800);
  await page.$eval('#content', (el) => el.scrollTo(0, 0));
  await page.waitForTimeout(500);
  const loaded = await page.$$eval('img.media', (imgs) => imgs.map((i) => ({ src: i.src, ok: i.complete && i.naturalWidth > 0 })));
  check(loaded.length >= 2 && loaded.every((i) => i.ok), `все фото карточек загрузились из кеша (${loaded.length})`);
  await page.click('.card[data-item="c1"]');
  await page.waitForTimeout(600);
  const gallery = await page.$$eval('.gallery img.media', (imgs) => imgs.map((i) => i.complete && i.naturalWidth > 0));
  check(gallery.length === 2 && gallery.every(Boolean), 'галерея медовика (2 крупных фото) без сети');
  await ctx.close();

  console.log('3. Новая версия: фото прежней удаляются после загрузки новой');
  server = await startServer({ port: PORT, env });
  await api.login('olga', 'owner-password-123');
  const eclair2 = await api.upload('#c08a5a', 'Эклер 2');
  ctx = await chromium.launchPersistentContext(profile, { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
  page = ctx.pages()[0] ?? (await ctx.newPage());
  await page.goto(`${server.base}/?diag=1`);
  await page.waitForSelector('.card');
  await precacheDone(page, v1);
  await api('PATCH', '/api/admin/items/p2', { photos: [eclair2.id] });
  await api('POST', '/api/admin/publish', { note: 'e2e v2' });
  const v2 = (await (await fetch(`${server.base}/api/menu`)).json()).version;
  const s2 = await precacheDone(page, v2); // планшет получает версию по SSE без перезагрузки
  check(s2.complete && s2.pruned > 0, `версия ${v2} загружена, удалено старых фото: ${s2.pruned}`);
  const urls2 = await cachedUrls(page);
  check(urls2.some((u) => u.startsWith(`/media/${eclair2.id}-`)) && !urls2.some((u) => u.startsWith(`/media/${eclair.id}-`)), 'старое фото эклера удалено, новое в кеше');
  check(urls2.some((u) => u.startsWith(`/media/${honey1.id}-`)), 'фото медовика (не менялись) остались');

  console.log('4. Загрузка новой версии оборвалась — рабочая версия не теряется');
  const broken = await api.upload('#555', 'Сломано');
  const { rm: rmFile } = await import('node:fs/promises');
  for (const w of broken.widths) for (const ext of ['webp', 'jpg']) await rmFile(path.join(dataDir, 'media', `${broken.id}-${w}.${ext}`));
  await api('PATCH', '/api/admin/items/c1', { photos: [broken.id] });
  await api('POST', '/api/admin/publish', { note: 'e2e v3 с недоступным фото' });
  const v3 = (await (await fetch(`${server.base}/api/menu`)).json()).version;
  const s3 = await precacheDone(page, v3);
  check(!s3.complete && s3.failed > 0 && s3.pruned === 0, `версия ${v3}: ошибок ${s3.failed}, ничего не удалено`);
  const urls3 = await cachedUrls(page);
  check(urls3.some((u) => u.startsWith(`/media/${honey1.id}-`)) && urls3.some((u) => u.startsWith(`/media/${honey2.id}-`)), 'фото медовика прежней версии на месте');
  check((await brokenImages(page)).length <= 1, 'на экране не больше одного битого фото (то, что недоступно на сервере)');
  console.log('\nOK: офлайн-режим работает');
} catch (err) {
  console.error(err.message);
  if (server) console.error('--- лог сервера ---\n' + server.log().slice(-3000));
  process.exitCode = 1;
} finally {
  await ctx?.close().catch(() => {});
  await stopServer(server);
  await rm(dataDir, { recursive: true, force: true });
  await rm(profile, { recursive: true, force: true });
}
