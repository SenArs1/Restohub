import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile, rm, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { openDb } from '../server/db.js';
import { createBackup, listBackups, pruneBackups, restoreBackup, verifyBackup, PID_FILE } from '../server/backup.js';
import { startRestohub } from './restohub-stand.js';

test('резервная копия на работающем сервере → проверка → восстановление в пустую папку', async (t) => {
  const { client, db, dataDir } = await startRestohub(t);
  const backupDir = await mkdtemp(path.join(tmpdir(), 'rh-backups-'));
  const restoreDir = await mkdtemp(path.join(tmpdir(), 'rh-restore-'));
  t.after(() => Promise.all([rm(backupDir, { recursive: true, force: true }), rm(restoreDir, { recursive: true, force: true })]));

  const o = client();
  await o.login('olga', 'owner-password-123');
  const photo = await sharp({ create: { width: 900, height: 600, channels: 3, background: '#c9786f' } }).jpeg().toBuffer();
  const id = (await o('POST', '/api/admin/media', photo, { 'Content-Type': 'image/jpeg' })).body.media.id;
  await o('PATCH', '/api/admin/items/p-1', { title: 'Медовик «Мади»', photos: [id] });
  await o('POST', '/api/admin/publish', { note: 'до копии' });
  await o('PATCH', '/api/admin/items/p-1', { description: 'только в черновике' }); // последние записи — в WAL

  const { name, dir, manifest } = await createBackup({ db, dataDir, backupDir, kind: 'manual' });
  assert.match(name, /^restohub-manual-\d{8}-\d{6}$/);
  assert.deepEqual([manifest.counts.publications, manifest.counts.media, manifest.counts.users], [1, 1, 2]);
  assert.ok(manifest.files['media/' + id + '-800.webp']);
  assert.equal((await verifyBackup(dir)).ok, true);
  assert.equal((await listBackups(backupDir))[0].name, name);

  // Изменения после копии не должны попасть в восстановленные данные.
  await o('PATCH', '/api/admin/items/p-1', { title: 'после копии' });

  const r = await restoreBackup({ dir, dataDir: restoreDir });
  assert.ok(r.restored > 3);
  const restored = openDb(path.join(restoreDir, 'restohub.db'));
  const draft = JSON.parse(restored.prepare("SELECT data FROM item_content WHERE item_id = 'p-1'").get().data);
  assert.equal(draft.title, 'Медовик «Мади»');
  assert.equal(draft.description, 'только в черновике', 'данные из WAL попали в копию');
  assert.equal(restored.prepare('SELECT COUNT(*) AS n FROM publication').get().n, 1);
  restored.close();
  assert.ok((await readdir(path.join(restoreDir, 'media'))).some((f) => f.startsWith(id)));
  assert.ok(JSON.parse(await readFile(path.join(restoreDir, 'iiko-snapshot.json'), 'utf8')).content);
});

test('проверка копии находит повреждения; восстановление сохраняет прежние данные и не идёт при запущенном сервере', async (t) => {
  const { db, dataDir } = await startRestohub(t);
  const backupDir = await mkdtemp(path.join(tmpdir(), 'rh-backups-'));
  t.after(() => rm(backupDir, { recursive: true, force: true }));
  const { dir } = await createBackup({ db, dataDir, backupDir });

  // Сервер «запущен»: PID-файл с живым процессом (родительским).
  await writeFile(path.join(dataDir, PID_FILE), String(process.ppid));
  await assert.rejects(restoreBackup({ dir, dataDir }), /запущен/);
  await rm(path.join(dataDir, PID_FILE));

  // Повреждённый снимок iiko в копии → проверка не проходит, восстановление отказывает.
  const snap = path.join(dir, 'iiko-snapshot.json');
  const original = await readFile(snap);
  await writeFile(snap, '{"broken": true}');
  const bad = await verifyBackup(dir);
  assert.equal(bad.ok, false);
  assert.match(bad.errors.join(), /iiko-snapshot\.json/);
  await assert.rejects(restoreBackup({ dir, dataDir }), /не прошла проверку/);
  await writeFile(snap, original);

  // Восстановление поверх существующих данных: прежние переносятся в pre-restore-*.
  await writeFile(path.join(dataDir, 'marker.txt'), 'x');
  const r = await restoreBackup({ dir, dataDir });
  assert.match(path.basename(r.previousData), /^pre-restore-/);
  assert.ok((await readdir(r.previousData)).includes('restohub.db'));
});

test('хранится BACKUP_KEEP последних автокопий, ручные не удаляются', async (t) => {
  const backupDir = await mkdtemp(path.join(tmpdir(), 'rh-backups-'));
  t.after(() => rm(backupDir, { recursive: true, force: true }));
  for (const n of ['auto-20261001-000000', 'auto-20261002-000000', 'auto-20261003-000000', 'manual-20261001-000000']) {
    const dir = path.join(backupDir, `restohub-${n}`);
    await (await import('node:fs/promises')).mkdir(dir);
    await writeFile(path.join(dir, 'manifest.json'), JSON.stringify({ kind: n.split('-')[0], createdAt: '', counts: {}, files: {} }));
  }
  assert.deepEqual(await pruneBackups(backupDir, 2), ['restohub-auto-20261001-000000']);
  assert.deepEqual((await listBackups(backupDir)).map((b) => b.name), ['restohub-manual-20261001-000000', 'restohub-auto-20261003-000000', 'restohub-auto-20261002-000000']);
});
