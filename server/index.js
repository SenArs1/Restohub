import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { openDb } from './db.js';
import { Auth } from './auth.js';
import { ContentStore } from './content.js';
import { IikoSync } from './sync.js';
import { Publisher } from './publisher.js';
import { createApp } from './app.js';
import { PID_FILE, createBackup, listBackups, pruneBackups } from './backup.js';

mkdirSync(config.dataDir, { recursive: true });
const db = openDb(path.join(config.dataDir, 'restohub.db'));
const auth = new Auth(db, { idleHours: config.sessionIdleHours });
const content = new ContentStore(db);
const sync = new IikoSync(config);
const publisher = new Publisher({ config, sync, content });
const tls = config.tlsCertFile && config.tlsKeyFile
  ? { cert: readFileSync(config.tlsCertFile), key: readFileSync(config.tlsKeyFile) }
  : null;
const server = createApp({ config, sync, content, auth, publisher, tls });

// PID-файл: восстановление из копии откажется работать, пока сервер запущен.
const pidFile = path.join(config.dataDir, PID_FILE);
writeFileSync(pidFile, String(process.pid));
const cleanup = () => rmSync(pidFile, { force: true });
process.on('exit', cleanup);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));

/** Автоматическая копия, если последняя старше интервала; старые автокопии удаляются. */
async function autoBackup() {
  try {
    const last = (await listBackups(config.backupDir)).find((b) => b.name.startsWith('restohub-auto-'));
    if (last?.createdAt && Date.now() - Date.parse(last.createdAt) < config.backupIntervalHours * 3600 * 1000 * 0.95) return;
    const { name } = await createBackup({ db, dataDir: config.dataDir, backupDir: config.backupDir, kind: 'auto' });
    const removed = await pruneBackups(config.backupDir, config.backupKeep);
    console.log(`[backup] автокопия ${name}${removed.length ? `, удалены старые: ${removed.length}` : ''}`);
  } catch (err) {
    console.error('[backup] автокопия не создана:', err.message);
  }
}

await sync.init();
publisher.rebuild();
if (config.backupIntervalHours > 0) {
  setTimeout(autoBackup, 60 * 1000).unref();
  setInterval(autoBackup, Math.min(config.backupIntervalHours, 6) * 3600 * 1000).unref();
}
server.listen(config.port, config.host, () => {
  const scheme = tls ? 'https' : 'http';
  console.log(`Restohub: ${scheme}://${config.host}:${config.port}  (источник: ${config.demo ? 'демо-данные' : 'iikoCloud'})`);
  console.log(`Админка:  ${scheme}://${config.host}:${config.port}/admin`);
  if (!tls && !config.trustProxy) {
    console.warn('ВНИМАНИЕ: HTTPS не настроен. Без HTTPS планшеты не смогут работать офлайн после перезапуска браузера,'
      + ' экран может гаснуть, а пароль админки передаётся открыто. Задайте TLS_CERT_FILE/TLS_KEY_FILE'
      + ' или поставьте сервер за HTTPS-прокси с TRUST_PROXY=1 (см. README).');
  }
  if (!auth.hasUsers()) console.log('Пользователей админки нет — создайте: npm run admin:user -- <логин> owner');
});
