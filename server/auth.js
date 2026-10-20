// Вход в админку: пароли на scrypt, сессии в SQLite (храним только хеш токена), лимит попыток.
import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb);
const SESSION_DAYS = 14;
const TOUCH_EVERY_MS = 5 * 60 * 1000; // как часто обновлять время активности сессии
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

const badRequest = (message) => Object.assign(new Error(message), { status: 400 });
export const generatePassword = () => randomBytes(12).toString('base64url');

export class Auth {
  /** @param idleHours — сессия завершается, если ей не пользовались столько часов */
  constructor(db, { idleHours = 24 } = {}) {
    this.db = db;
    this.idleMs = idleHours * 3600 * 1000;
    this.failures = new Map(); // ключ (ip или логин) → { count, since }
  }

  async upsertUser(login, password, role = 'manager') {
    if (!/^[a-z0-9._-]{3,32}$/i.test(login)) throw badRequest('Логин: 3–32 символа, латиница, цифры, . _ -');
    if (String(password).length < 10) throw badRequest('Пароль: не короче 10 символов');
    if (!['owner', 'manager'].includes(role)) throw badRequest('Роль: owner или manager');
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

  listUsers() {
    return this.db.prepare(`
      SELECT u.login, u.role, u.created_at AS createdAt, MAX(s.last_seen_at) AS lastSeenAt
      FROM users u LEFT JOIN sessions s ON s.user_id = u.id
      GROUP BY u.id ORDER BY u.role DESC, u.login`).all();
  }

  #user(login) {
    const u = this.db.prepare('SELECT * FROM users WHERE login = ?').get(String(login).toLowerCase());
    if (!u) throw Object.assign(new Error(`Пользователь ${login} не найден`), { status: 404 });
    return u;
  }

  #ownersExcept(login) {
    return this.db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'owner' AND login != ?").get(String(login).toLowerCase()).n;
  }

  async createUser(login, role) {
    if (this.db.prepare('SELECT 1 FROM users WHERE login = ?').get(String(login).toLowerCase())) {
      throw Object.assign(new Error(`Пользователь ${login} уже есть`), { status: 409 });
    }
    const password = generatePassword();
    await this.upsertUser(login, password, role);
    return password;
  }

  async resetPassword(login) {
    const u = this.#user(login);
    const password = generatePassword();
    await this.upsertUser(u.login, password, u.role);
    return password;
  }

  setRole(login, role) {
    const u = this.#user(login);
    if (!['owner', 'manager'].includes(role)) throw badRequest('Роль: owner или manager');
    if (u.role === 'owner' && role !== 'owner' && !this.#ownersExcept(u.login)) throw badRequest('Нельзя понизить последнего владельца');
    this.db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, u.id);
  }

  deleteUser(login) {
    const u = this.#user(login);
    if (u.role === 'owner' && !this.#ownersExcept(u.login)) throw badRequest('Нельзя удалить последнего владельца');
    this.db.prepare('DELETE FROM users WHERE id = ?').run(u.id);
  }

  /** Смена своего пароля: нужен текущий; остальные сессии пользователя завершаются, текущая — тоже. */
  async changePassword(login, current, next) {
    const u = this.#user(login);
    if (!(await verifyPassword(String(current), u.password_hash))) throw Object.assign(new Error('Текущий пароль неверный'), { status: 403 });
    await this.upsertUser(u.login, String(next ?? ''), u.role);
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
      .prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?)')
      .run(sha256(token), user.id, created.toISOString(), expires.toISOString(), created.toISOString());
    return { token, user: { login: user.login, role: user.role }, maxAge: SESSION_DAYS * 86400 };
  }

  /** Пользователь по токену сессии; просроченные и простаивающие сессии удаляются. */
  userBySession(token) {
    if (!token) return null;
    const hash = sha256(token);
    const row = this.db
      .prepare(`SELECT u.login, u.role, s.expires_at, s.last_seen_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`)
      .get(hash);
    if (!row) return null;
    const now = Date.now();
    const lastSeen = Date.parse(row.last_seen_at ?? 0);
    if (Date.parse(row.expires_at) < now || now - lastSeen > this.idleMs) {
      this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hash);
      return null;
    }
    if (now - lastSeen > TOUCH_EVERY_MS) {
      this.db.prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?').run(new Date(now).toISOString(), hash);
    }
    return { login: row.login, role: row.role };
  }

  logout(token) {
    if (token) this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
  }
}
