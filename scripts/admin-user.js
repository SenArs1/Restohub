// Создать пользователя админки или сменить ему пароль.
// npm run admin:user -- <логин> [owner|manager] [--password=...]
// Без --password генерируется надёжный пароль и выводится один раз.
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { config } from '../server/config.js';
import { openDb } from '../server/db.js';
import { Auth } from '../server/auth.js';

const args = process.argv.slice(2);
const login = args.find((a) => !a.startsWith('--') && !['owner', 'manager'].includes(a));
const role = args.find((a) => ['owner', 'manager'].includes(a)) ?? 'manager';
const given = args.find((a) => a.startsWith('--password='))?.slice('--password='.length);

if (!login) {
  console.error('Использование: npm run admin:user -- <логин> [owner|manager] [--password=...]');
  process.exit(1);
}

mkdirSync(config.dataDir, { recursive: true });
const auth = new Auth(openDb(path.join(config.dataDir, 'restohub.db')));
const password = given ?? randomBytes(12).toString('base64url');
try {
  await auth.upsertUser(login, password, role);
  console.log(`Пользователь ${login.toLowerCase()} (${role}) сохранён.`);
  if (!given) console.log(`Пароль: ${password}\nСохраните его — повторно он не показывается.`);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
