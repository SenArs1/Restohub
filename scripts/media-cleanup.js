// Очистка неиспользуемых фото.
//   npm run media:cleanup            — показать, что будет удалено (ничего не удаляет)
//   npm run media:cleanup -- --apply — удалить
// Фото из черновика и любой публикации в истории не удаляются никогда.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { config } from '../server/config.js';
import { openDb } from '../server/db.js';
import { cleanupMedia, planMediaCleanup } from '../server/maintenance.js';

const apply = process.argv.includes('--apply');
const snapshots = ['iiko-snapshot.json', 'iiko-snapshot.prev.json']
  .map((f) => path.join(config.dataDir, f))
  .filter(existsSync)
  .map((f) => { try { return JSON.parse(readFileSync(f, 'utf8')).content; } catch { return null; } })
  .filter(Boolean);
const opts = { db: openDb(path.join(config.dataDir, 'restohub.db')), mediaDir: path.join(config.dataDir, 'media'), snapshots, graceHours: config.mediaGraceHours };
const plan = apply ? await cleanupMedia(opts) : await planMediaCleanup(opts);
console.log(`${apply ? 'Удалено' : 'Будет удалено'}: фото ${plan.media.length}, файлов без записи ${plan.orphanFiles.length}, старых фото iiko ${plan.iikoFiles.length}, временных ${plan.tmpFiles.length} — ${(plan.bytes / 1024 / 1024).toFixed(1)} МБ`);
console.log(`Сохраняются: фото в базе ${plan.kept.media}, из них используются в черновике или истории ${plan.kept.referenced}; моложе ${config.mediaGraceHours} ч не трогаются`);
if (!apply && (plan.media.length || plan.orphanFiles.length || plan.iikoFiles.length || plan.tmpFiles.length)) console.log('Чтобы удалить: npm run media:cleanup -- --apply');
