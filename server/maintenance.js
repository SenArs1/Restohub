// Очистка неиспользуемых фото. Фото удаляется, только если его нет ни в черновике, ни в одной
// публикации из истории (иначе откат к ней показал бы пустые карточки), и оно старше «льготного»
// периода — чтобы не удалить фото, которое только что загрузили, но ещё не сохранили в блюдо.
import { readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';

const OWN_FILE = /^([0-9a-f]{20})-(\d+)\.(webp|jpg)$/; // фото из админки: <id>-<ширина>.<ext>
const IIKO_FILE = /^[0-9a-f]{20}\.(jpe?g|png|webp|gif)$/; // фото, скачанные из iiko
const TMP_FILE = /\.tmp$/;

function photosOf(overlay, into) {
  for (const group of [overlay?.items, overlay?.categories]) {
    for (const entry of Object.values(group ?? {})) for (const id of entry.photos ?? []) into.add(id);
  }
  return into;
}

/** Все id фото, на которые ссылаются черновик и вся история публикаций. */
export function referencedMedia(db) {
  const used = new Set();
  for (const table of ['item_content', 'category_content']) {
    for (const r of db.prepare(`SELECT data FROM ${table}`).all()) for (const id of JSON.parse(r.data).photos ?? []) used.add(id);
  }
  for (const r of db.prepare('SELECT overlay FROM publication').all()) photosOf(JSON.parse(r.overlay), used);
  return used;
}

/** Локальные фото iiko из снимков (текущего, запасного и удержанного). */
function iikoFilesInUse(snapshots) {
  const used = new Set();
  for (const snap of snapshots) {
    for (const cat of snap?.categories ?? []) {
      for (const node of [cat, ...(cat.items ?? [])]) if (node.image?.startsWith('/media/')) used.add(node.image.slice('/media/'.length));
    }
  }
  return used;
}

/**
 * План очистки (ничего не удаляет).
 * @param snapshots содержимое снимков iiko, фото которых нужно сохранить
 */
export async function planMediaCleanup({ db, mediaDir, snapshots = [], graceHours = 24, now = Date.now() }) {
  const grace = graceHours * 3600 * 1000;
  const used = referencedMedia(db);
  const iikoUsed = iikoFilesInUse(snapshots);
  const rows = new Map(db.prepare('SELECT id, created_at FROM media').all().map((r) => [r.id, r.created_at]));

  let names = [];
  try {
    names = await readdir(mediaDir);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const files = await Promise.all(names.map(async (name) => {
    const st = await stat(path.join(mediaDir, name)).catch(() => null);
    return st?.isFile() ? { name, bytes: st.size, mtime: st.mtimeMs } : null;
  }));

  const removeIds = new Set();
  for (const [id, createdAt] of rows) {
    if (!used.has(id) && now - Date.parse(createdAt) > grace) removeIds.add(id);
  }

  const plan = { media: [], orphanFiles: [], iikoFiles: [], tmpFiles: [], bytes: 0, kept: { media: rows.size - removeIds.size, referenced: used.size } };
  const byId = new Map();
  for (const f of files.filter(Boolean)) {
    const own = f.name.match(OWN_FILE);
    const old = now - f.mtime > grace;
    if (own) {
      const id = own[1];
      if (removeIds.has(id)) {
        if (!byId.has(id)) byId.set(id, { id, createdAt: rows.get(id), files: [], bytes: 0 });
        byId.get(id).files.push(f.name);
        byId.get(id).bytes += f.bytes;
        plan.bytes += f.bytes;
      } else if (!rows.has(id) && old) {
        // Файл без записи в базе: например, обработка прервалась на середине.
        plan.orphanFiles.push(f.name);
        plan.bytes += f.bytes;
      }
    } else if (IIKO_FILE.test(f.name)) {
      if (!iikoUsed.has(f.name) && old) {
        plan.iikoFiles.push(f.name);
        plan.bytes += f.bytes;
      }
    } else if (TMP_FILE.test(f.name) && old) {
      plan.tmpFiles.push(f.name);
      plan.bytes += f.bytes;
    }
  }
  // Записи без файлов тоже удаляются, если они не используются.
  for (const id of removeIds) if (!byId.has(id)) byId.set(id, { id, createdAt: rows.get(id), files: [], bytes: 0 });
  plan.media = [...byId.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return plan;
}

/** Выполняет очистку по свежему плану (план пересчитывается, чтобы не удалить ставшее нужным). */
export async function cleanupMedia(opts) {
  const plan = await planMediaCleanup(opts);
  const { db, mediaDir } = opts;
  // Повторная проверка ссылок: фото могли добавить в блюдо, пока строился план.
  const used = referencedMedia(db);
  plan.media = plan.media.filter((m) => !used.has(m.id));
  const files = [...plan.media.flatMap((m) => m.files), ...plan.orphanFiles, ...plan.iikoFiles, ...plan.tmpFiles];
  // Сначала строки (в транзакции), потом файлы.
  const del = db.prepare('DELETE FROM media WHERE id = ?');
  db.exec('BEGIN');
  try {
    for (const m of plan.media) del.run(m.id);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  await Promise.all(files.map((f) => rm(path.join(mediaDir, f), { force: true })));
  return { ...plan, removedFiles: files.length };
}
