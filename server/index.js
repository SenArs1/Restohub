import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { openDb } from './db.js';
import { Auth } from './auth.js';
import { ContentStore } from './content.js';
import { IikoSync } from './sync.js';
import { Publisher } from './publisher.js';
import { createApp } from './app.js';

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

await sync.init();
publisher.rebuild();
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
