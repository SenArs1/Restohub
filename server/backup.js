// Резервные копии Restohub: база SQLite (целостный снимок через VACUUM INTO — работает и на
// запущенном сервере), фото и снимок iiko. В каждой копии — manifest.json с размерами и SHA-256
// файлов, поэтому копию можно проверить до восстановления.
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { SCHEMA_VERSION } from './db.js';

const DB_FILE = 'restohub.db';
const SNAPSHOTS = ['iiko-snapshot.json', 'iiko-snapshot.prev.json'];
export const PID_FILE = 'restohub.pid';
const NAME = /^restohub-(auto|manual)-\d{8}-\d{6}$/;

const appVersion = () => JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const stamp = (d = new Date()) => d.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);

async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function describe(root, rel) {
  const file = path.join(root, rel);
  return { bytes: (await stat(file)).size, sha256: await sha256(file) };
}

async function listFiles(dir) {
  try {
    return (await readdir(dir, { withFileTypes: true })).filter((e) => e.isFile() && !e.name.endsWith('.tmp')).map((e) => e.name);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

/**
 * @param kind 'auto' (по расписанию, старые удаляются) или 'manual'
 * @returns { name, dir, manifest }
 */
export async function createBackup({ db, dataDir, backupDir, kind = 'manual' }) {
  await mkdir(backupDir, { recursive: true });
  let name = `restohub-${kind}-${stamp()}`;
  while (existsSync(path.join(backupDir, name))) name = `restohub-${kind}-${stamp(new Date(Date.now() + 1000))}`;
  const tmp = path.join(backupDir, `.${name}.partial`);
  const dir = path.join(backupDir, name);
  await rm(tmp, { recursive: true, force: true });
  await mkdir(path.join(tmp, 'media'), { recursive: true });
  try {
    db.exec(`VACUUM INTO '${path.join(tmp, DB_FILE).replaceAll("'", "''")}'`);
    const files = [DB_FILE];
    for (const f of SNAPSHOTS) {
      if (existsSync(path.join(dataDir, f))) {
        await copyFile(path.join(dataDir, f), path.join(tmp, f));
        files.push(f);
      }
    }
    for (const f of await listFiles(path.join(dataDir, 'media'))) {
      await copyFile(path.join(dataDir, 'media', f), path.join(tmp, 'media', f));
      files.push(`media/${f}`);
    }
    const copy = new DatabaseSync(path.join(tmp, DB_FILE), { readOnly: true });
    const count = (t) => copy.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
    const manifest = {
      app: 'restohub',
      appVersion: appVersion(),
      schemaVersion: copy.prepare('PRAGMA user_version').get().user_version,
      createdAt: new Date().toISOString(),
      kind,
      counts: { publications: count('publication'), media: count('media'), users: count('users'), mediaFiles: files.length - 1 - files.filter((f) => SNAPSHOTS.includes(f)).length },
      files: {},
    };
    copy.close();
    for (const f of files) manifest.files[f] = await describe(tmp, f);
    await writeFile(path.join(tmp, 'manifest.json'), JSON.stringify(manifest, null, 2));
    await rename(tmp, dir); // копия появляется целиком или не появляется вовсе
    return { name, dir, manifest };
  } catch (err) {
    await rm(tmp, { recursive: true, force: true });
    throw err;
  }
}

/** Проверка копии: манифест, хеши, целостность базы, версия схемы, наличие всех фото из базы. */
export async function verifyBackup(dir) {
  const errors = [];
  let manifest;
  try {
    manifest = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8'));
  } catch (err) {
    return { ok: false, errors: [`manifest.json не читается: ${err.message}`] };
  }
  if (manifest.app !== 'restohub') errors.push('Это не копия Restohub');
  if (manifest.schemaVersion > SCHEMA_VERSION) errors.push(`Копия от более новой версии (схема ${manifest.schemaVersion}, поддерживается ${SCHEMA_VERSION})`);
  for (const [rel, expected] of Object.entries(manifest.files ?? {})) {
    const file = path.join(dir, rel);
    if (!existsSync(file)) { errors.push(`Нет файла ${rel}`); continue; }
    const actual = await describe(dir, rel);
    if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) errors.push(`Файл изменён или повреждён: ${rel}`);
  }
  if (!manifest.files?.[DB_FILE]) errors.push(`В копии нет ${DB_FILE}`);
  else if (existsSync(path.join(dir, DB_FILE))) {
    try {
      const db = new DatabaseSync(path.join(dir, DB_FILE), { readOnly: true });
      const integrity = db.prepare('PRAGMA integrity_check').get().integrity_check;
      if (integrity !== 'ok') errors.push(`База повреждена: ${integrity}`);
      for (const m of db.prepare('SELECT id, widths FROM media').all()) {
        for (const w of JSON.parse(m.widths)) {
          for (const ext of ['webp', 'jpg']) if (!manifest.files[`media/${m.id}-${w}.${ext}`]) errors.push(`Нет фото media/${m.id}-${w}.${ext}`);
        }
      }
      db.close();
    } catch (err) {
      errors.push(`База не открывается: ${err.message}`);
    }
  }
  return { ok: errors.length === 0, errors, manifest };
}

export async function listBackups(backupDir) {
  let names = [];
  try {
    names = (await readdir(backupDir)).filter((n) => NAME.test(n)).sort().reverse();
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  return Promise.all(names.map(async (name) => {
    try {
      const m = JSON.parse(await readFile(path.join(backupDir, name, 'manifest.json'), 'utf8'));
      const bytes = Object.values(m.files).reduce((s, f) => s + f.bytes, 0);
      return { name, kind: m.kind, createdAt: m.createdAt, appVersion: m.appVersion, counts: m.counts, bytes };
    } catch {
      return { name, error: 'нет или повреждён manifest.json' };
    }
  }));
}

/** Оставляет `keep` последних автоматических копий; ручные не трогает. */
export async function pruneBackups(backupDir, keep) {
  const auto = (await listBackups(backupDir)).filter((b) => b.name.startsWith('restohub-auto-'));
  const remove = auto.slice(keep);
  for (const b of remove) await rm(path.join(backupDir, b.name), { recursive: true, force: true });
  return remove.map((b) => b.name);
}

export function serverRunning(dataDir) {
  try {
    const pid = Number(readFileSync(path.join(dataDir, PID_FILE), 'utf8'));
    if (!pid || pid === process.pid) return false;
    process.kill(pid, 0);
    return pid;
  } catch {
    return false;
  }
}

/**
 * Восстановление из копии. Сервер должен быть остановлен. Текущие данные не удаляются,
 * а переносятся в <dataDir>/pre-restore-<время> — их можно вернуть вручную.
 */
export async function restoreBackup({ dir, dataDir, force = false }) {
  const pid = serverRunning(dataDir);
  if (pid && !force) throw new Error(`Сервер Restohub запущен (pid ${pid}) — остановите его перед восстановлением`);
  const check = await verifyBackup(dir);
  if (!check.ok) throw new Error(`Копия не прошла проверку:\n- ${check.errors.join('\n- ')}`);

  await mkdir(dataDir, { recursive: true });
  const saved = path.join(dataDir, `pre-restore-${stamp()}`);
  await mkdir(saved, { recursive: true });
  for (const f of [DB_FILE, `${DB_FILE}-wal`, `${DB_FILE}-shm`, ...SNAPSHOTS, 'media']) {
    if (existsSync(path.join(dataDir, f))) await rename(path.join(dataDir, f), path.join(saved, f));
  }
  await mkdir(path.join(dataDir, 'media'), { recursive: true });
  for (const rel of Object.keys(check.manifest.files)) await copyFile(path.join(dir, rel), path.join(dataDir, rel));
  return { restored: Object.keys(check.manifest.files).length, previousData: saved, manifest: check.manifest };
}
