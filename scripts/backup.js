// Резервные копии из командной строки.
//   npm run backup                      — создать копию (можно при запущенном сервере)
//   npm run backup -- list              — список копий
//   npm run backup -- verify <имя>      — проверить копию (хеши, целостность базы, фото)
//   npm run backup -- restore <имя>     — восстановить (сервер должен быть остановлен)
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { config } from '../server/config.js';
import { openDb } from '../server/db.js';
import { createBackup, listBackups, restoreBackup, verifyBackup } from '../server/backup.js';

const [cmd = 'create', name] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const force = process.argv.includes('--force');
const dirOf = (n) => (path.isAbsolute(n) || n.includes('/') ? path.resolve(n) : path.join(config.backupDir, n));
const mb = (b) => `${(b / 1024 / 1024).toFixed(1)} МБ`;

try {
  if (cmd === 'create') {
    mkdirSync(config.dataDir, { recursive: true });
    const { dir, manifest } = await createBackup({ db: openDb(path.join(config.dataDir, 'restohub.db')), dataDir: config.dataDir, backupDir: config.backupDir });
    console.log(`Копия создана: ${dir}\nПубликаций: ${manifest.counts.publications}, фото: ${manifest.counts.media}, файлов фото: ${manifest.counts.mediaFiles}, пользователей: ${manifest.counts.users}`);
  } else if (cmd === 'list') {
    const list = await listBackups(config.backupDir);
    if (!list.length) console.log(`Копий нет (${config.backupDir})`);
    for (const b of list) console.log(b.error ? `${b.name}  ⚠ ${b.error}` : `${b.name}  ${b.createdAt}  ${mb(b.bytes)}  публикаций ${b.counts.publications}, фото ${b.counts.media}`);
  } else if (cmd === 'verify') {
    if (!name) throw new Error('Укажите имя копии');
    const { ok, errors, manifest } = await verifyBackup(dirOf(name));
    if (ok) console.log(`Копия в порядке: ${Object.keys(manifest.files).length} файлов, схема ${manifest.schemaVersion}, создана ${manifest.createdAt}`);
    else { console.error(`Копия НЕ прошла проверку:\n- ${errors.join('\n- ')}`); process.exit(2); }
  } else if (cmd === 'restore') {
    if (!name) throw new Error('Укажите имя копии');
    const r = await restoreBackup({ dir: dirOf(name), dataDir: config.dataDir, force });
    console.log(`Восстановлено файлов: ${r.restored}\nПрежние данные сохранены в ${r.previousData}\nЗапустите сервер: npm start`);
  } else {
    throw new Error(`Неизвестная команда ${cmd}`);
  }
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
