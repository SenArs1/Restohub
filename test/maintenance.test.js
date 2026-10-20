import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readdir, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { startRestohub } from './restohub-stand.js';

const jpeg = (color) => sharp({ create: { width: 900, height: 600, channels: 3, background: color } }).jpeg().toBuffer();
const old = (db, id) => db.prepare("UPDATE media SET created_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(id);

test('очистка фото: история публикаций, черновик и свежие загрузки сохраняются', async (t) => {
  const { client, db, dataDir, sync } = await startRestohub(t);
  const o = client();
  await o.login('olga', 'owner-password-123');
  const upload = async (color) => (await o('POST', '/api/admin/media', await jpeg(color), { 'Content-Type': 'image/jpeg' })).body.media.id;
  const [historyOnly, draftOnly, unused, fresh] = [await upload('#a00'), await upload('#0a0'), await upload('#00a'), await upload('#aaa')];
  const media = path.join(dataDir, 'media');

  await o('PATCH', '/api/admin/items/p-1', { photos: [historyOnly] });
  const first = (await o('POST', '/api/admin/publish', { note: 'с фото A' })).body.publication;
  await o('PATCH', '/api/admin/items/p-1', { photos: [] });
  await o('POST', '/api/admin/publish', { note: 'без фото' });
  await o('PATCH', '/api/admin/categories/cat-1', { photos: [draftOnly] }); // только в черновике
  for (const id of [historyOnly, draftOnly, unused]) old(db, id); // «fresh» загружено только что

  // Мусор: файл без записи в базе, недокачанный файл, неиспользуемое фото iiko; все — старые.
  const past = new Date('2000-01-01');
  for (const f of ['ffffffffffffffffffff-800.jpg', 'x.jpg.123.tmp', 'eeeeeeeeeeeeeeeeeeee.jpg']) {
    await writeFile(path.join(media, f), 'x');
    await utimes(path.join(media, f), past, past);
  }
  const iikoPhoto = path.basename(sync.snapshot.content.categories[0].items[0].image);
  await utimes(path.join(media, iikoPhoto), past, past);

  const plan = (await o('GET', '/api/admin/maintenance/media')).body.plan;
  assert.deepEqual([plan.media, plan.orphanFiles, plan.iikoFiles, plan.tmpFiles], [1, 1, 1, 1]);
  assert.equal(plan.kept.referenced, 2);

  const res = (await o('POST', '/api/admin/maintenance/media/cleanup')).body.result;
  assert.equal(res.media, 1);
  const files = await readdir(media);
  assert.ok(!files.some((f) => f.startsWith(unused)), 'неиспользуемое удалено');
  for (const id of [historyOnly, draftOnly, fresh]) assert.ok(files.some((f) => f.startsWith(id)), `${id} сохранено`);
  assert.ok(files.includes(iikoPhoto), 'фото iiko из текущего снимка сохранено');
  assert.ok(!files.includes('eeeeeeeeeeeeeeeeeeee.jpg') && !files.includes('ffffffffffffffffffff-800.jpg') && !files.includes('x.jpg.123.tmp'));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM media').get().n, 3);

  // Откат к публикации с фото A по-прежнему показывает фото.
  await o('POST', `/api/admin/publications/${first}/restore`);
  const item = (await o('GET', '/api/menu')).body.categories[0].items[0];
  assert.equal(item.images[0].id, historyOnly);
  assert.ok(existsSync(path.join(media, path.basename(item.image))));

  // Откат заменил черновик публикацией, где обложки категории не было: она больше нигде не используется
  // и при следующей очистке станет кандидатом на удаление. Остальное по-прежнему защищено.
  const again = (await o('GET', '/api/admin/maintenance/media')).body.plan;
  assert.deepEqual([again.media, again.orphanFiles, again.iikoFiles, again.tmpFiles], [1, 0, 0, 0]);
  assert.equal(again.kept.referenced, 1);
});
