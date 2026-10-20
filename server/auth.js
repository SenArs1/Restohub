// Вход в админку: пароли на scrypt, сессии в SQLite (храним только хеш токена), лимит попыток.
import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb);
const SESSION_DAYS = 14;
const MAX_FAILURES = 10;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;
export const SESSION_COOKIE = 'rh_session';

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  const [scheme, salt, hash] = String(stored).split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await scrypt(password, Buffer.from(salt, 'base64'), expected.length);
  return timingSafeEqual(actual, expected);
}

export class Auth {
  constructor(db) {
    this.db = db;
    this.failures = new Map(); // ключ (ip или логин) → { count, since }
  }

  async upsertUser(login, password, role = 'manager') {
    if (!/^[a-z0-9._-]{3,32}$/i.test(login)) throw new Error('Логин: 3–32 символа, латиница, цифры, . _ -');
    if (String(password).length < 10) throw new Error('Пароль: не короче 10 символов');
    if (!['owner', 'manager'].includes(role)) throw new Error('Роль: owner или manager');
    const hash = await hashPassword(password);
    this.db
      .prepare(`INSERT INTO users (login, password_hash, role, created_at) VALUES (?, ?, ?, ?)
                ON CONFLICT(login) DO UPDATE SET password_hash = excluded.password_hash, role = excluded.role`)
      .run(login.toLowerCase(), hash, role, new Date().toISOString());
    const user = this.db.prepare('SELECT id FROM users WHERE login = ?').get(login.toLowerCase());
    // После смены пароля старые сессии больше не действуют.
    this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
  }

  hasUsers() {
    return !!this.db.prepare('SELECT 1 FROM users LIMIT 1').get();
  }

  #blocked(keys) {
    const now = Date.now();
    return keys.some((k) => {
      const f = this.failures.get(k);
      return f && now - f.since < FAILURE_WINDOW_MS && f.count >= MAX_FAILURES;
    });
  }

  #fail(keys) {
    const now = Date.now();
    for (const k of keys) {
      const f = this.failures.get(k);
      this.failures.set(k, f && now - f.since < FAILURE_WINDOW_MS ? { count: f.count + 1, since: f.since } : { count: 1, since: now });
    }
  }

  /** @returns {{ token, user }} или бросает ошибку с полем status */
  async login(login, password, ip) {
    const keys = [`ip:${ip}`, `login:${String(login).toLowerCase()}`];
    if (this.#blocked(keys)) throw Object.assign(new Error('Слишком много попыток входа, попробуйте через 15 минут'), { status: 429 });
    const user = this.db.prepare('SELECT * FROM users WHERE login = ?').get(String(login).toLowerCase());
    const ok = user ? await verifyPassword(String(password), user.password_hash) : await verifyPassword('x', 'scrypt$AAAA$AAAA');
    if (!user || !ok) {
      this.#fail(keys);
      throw Object.assign(new Error('Неверный логин или пароль'), { status: 401 });
    }
    keys.forEach((k) => this.failures.delete(k));
    const token = randomBytes(32).toString('base64url');
    const created = new Date();
    const expires = new Date(created.getTime() + SESSION_DAYS * 864e5);
    this.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(created.toISOString());
    this.db
      .prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .run(sha256(token), user.id, created.toISOString(), expires.toISOString());
    return { token, user: { login: user.login, role: user.role }, maxAge: SESSION_DAYS * 86400 };
  }

  userBySession(token) {
    if (!token) return null;
    const row = this.db
      .prepare(`SELECT u.login, u.role, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`)
      .get(sha256(token));
    if (!row || row.expires_at < new Date().toISOString()) return null;
    return { login: row.login, role: row.role };
  }

  logout(token) {
    if (token) this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
  }
}
