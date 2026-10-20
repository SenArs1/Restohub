import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS item_content (
  item_id    TEXT PRIMARY KEY,
  data       TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT
);
CREATE TABLE IF NOT EXISTS category_content (
  category_id TEXT PRIMARY KEY,
  data        TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  updated_by  TEXT
);
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS media (
  id            TEXT PRIMARY KEY,
  width         INTEGER NOT NULL,
  height        INTEGER NOT NULL,
  widths        TEXT NOT NULL,
  bytes         INTEGER NOT NULL,
  original_name TEXT,
  created_at    TEXT NOT NULL,
  created_by    TEXT
);
CREATE TABLE IF NOT EXISTS publication (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  overlay    TEXT NOT NULL,
  note       TEXT,
  created_at TEXT NOT NULL,
  created_by TEXT
);
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  login         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('owner', 'manager')),
  created_at    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
`;

// Миграции по PRAGMA user_version. Базы P1 имеют версию 0 и схему SCHEMA выше.
// Каждая миграция идемпотентна: проверяет, нужно ли изменение, прежде чем его делать.
const hasColumn = (db, table, column) => db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);

const MIGRATIONS = [
  // 1: время последней активности сессии — для выхода по простою.
  (db) => {
    if (!hasColumn(db, 'sessions', 'last_seen_at')) db.exec('ALTER TABLE sessions ADD COLUMN last_seen_at TEXT');
    db.exec('UPDATE sessions SET last_seen_at = created_at WHERE last_seen_at IS NULL');
  },
];

export const SCHEMA_VERSION = MIGRATIONS.length;

/** Открывает базу Restohub (контент админки, фото, публикации, пользователи), создаёт таблицы и применяет миграции. */
export function openDb(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  const current = db.prepare('PRAGMA user_version').get().user_version;
  if (current > SCHEMA_VERSION) {
    throw new Error(`База создана более новой версией Restohub (схема ${current}, поддерживается ${SCHEMA_VERSION})`);
  }
  for (let v = current; v < SCHEMA_VERSION; v++) {
    db.exec('BEGIN');
    try {
      MIGRATIONS[v](db);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
  return db;
}
