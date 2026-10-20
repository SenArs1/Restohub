import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Минимальный загрузчик .env (без зависимостей). Переменные окружения процесса приоритетнее.
function loadEnvFile(file) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!m || line.trimStart().startsWith('#')) continue;
    const value = m[2].replace(/^(['"])(.*)\1$/, '$2');
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}
loadEnvFile(path.join(ROOT, '.env'));

const env = (k, d = '') => (process.env[k] ?? '').trim() || d;
const flag = (k, d) => ['1', 'true', 'yes'].includes(env(k, d ? '1' : '0').toLowerCase());
const num = (k, d) => Number(env(k, String(d))) || d;

export const config = {
  port: num('PORT', 8080),
  host: env('HOST', '0.0.0.0'),
  dataDir: env('DATA_DIR') ? path.resolve(ROOT, env('DATA_DIR')) : path.join(ROOT, 'data'),
  // Резервные копии: папка (лучше на другом диске), интервал автокопий в часах (0 — выключено), сколько хранить.
  backupDir: env('BACKUP_DIR') ? path.resolve(ROOT, env('BACKUP_DIR')) : path.join(ROOT, 'backups'),
  backupIntervalHours: Number(env('BACKUP_INTERVAL_HOURS', '24')),
  backupKeep: num('BACKUP_KEEP', 14),
  // Неиспользуемые фото моложе этого срока не удаляются (могли загрузить, но ещё не сохранить в блюдо).
  mediaGraceHours: num('MEDIA_GRACE_HOURS', 24),
  publicDir: path.join(ROOT, 'public'),

  restaurantName: env('RESTAURANT_NAME', 'Madi Cake'),
  currency: env('CURRENCY', '₽'),
  syncIntervalMin: num('SYNC_INTERVAL_MIN', 5),
  stopListIntervalSec: num('STOPLIST_INTERVAL_SEC', 60),
  // Через сколько минут без успешной синхронизации данные считаются устаревшими (предупреждение в админке).
  staleAfterMin: num('STALE_AFTER_MIN', 0),
  cookieSecure: flag('COOKIE_SECURE', false),
  // Сервер за обратным прокси (Caddy, nginx): доверять X-Forwarded-Proto/-For/-Host.
  trustProxy: flag('TRUST_PROXY', false),
  sessionIdleHours: num('SESSION_IDLE_HOURS', 24),
  // Встроенный HTTPS: пути к сертификату и ключу (PEM). Пусто — HTTP.
  tlsCertFile: env('TLS_CERT_FILE'),
  tlsKeyFile: env('TLS_KEY_FILE'),
  cacheImages: flag('CACHE_IMAGES', true),
  adminToken: env('ADMIN_TOKEN'),
  idleSeconds: num('IDLE_SECONDS', 90),
  demo: flag('DEMO', false) || !env('IIKO_API_LOGIN'),

  iiko: {
    apiLogin: env('IIKO_API_LOGIN'),
    clientSecret: env('IIKO_CLIENT_SECRET'),
    appId: env('IIKO_APP_ID'),
    apiUrl: env('IIKO_API_URL', 'https://api-ru.iiko.services').replace(/\/+$/, ''),
    organizationId: env('IIKO_ORGANIZATION_ID'),
    organizationName: env('IIKO_ORGANIZATION_NAME', 'Madi Cake'),
    externalMenuId: env('IIKO_EXTERNAL_MENU_ID'),
    externalMenuName: env('IIKO_EXTERNAL_MENU_NAME', 'Madi Cake'),
    priceCategoryId: env('IIKO_PRICE_CATEGORY_ID'),
    terminalGroupId: env('IIKO_TERMINAL_GROUP_ID'),
    menuVersion: env('IIKO_MENU_VERSION') ? Number(env('IIKO_MENU_VERSION')) : undefined,
    language: env('IIKO_LANGUAGE', 'ru'),
  },
};
