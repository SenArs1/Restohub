import { mkdirSync } from 'node:fs';
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
const auth = new Auth(db);
const content = new ContentStore(db);
const sync = new IikoSync(config);
const publisher = new Publisher({ config, sync, content });
const server = createApp({ config, sync, content, auth, publisher });

await sync.init();
publisher.rebuild();
server.listen(config.port, config.host, () => {
  console.log(`Restohub: http://${config.host}:${config.port}  (источник: ${config.demo ? 'демо-данные' : 'iikoCloud'})`);
  console.log(`Админка:  http://${config.host}:${config.port}/admin`);
  if (!auth.hasUsers()) console.log('Пользователей админки нет — создайте: npm run admin:user -- <логин> owner');
});
