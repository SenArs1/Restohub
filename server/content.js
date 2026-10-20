// Контент админки поверх iiko: черновик (редактируется), публикации (видят планшеты), фото.
import { BADGES, SOLD_OUT_MODES, emptyOverlay } from './compose.js';

const now = () => new Date().toISOString();

export class ValidationError extends Error {
  status = 400;
}

const fail = (msg) => { throw new ValidationError(msg); };

/** Канонический JSON: ключи по алфавиту, пустые значения отброшены — чтобы сравнивать черновик и публикацию. */
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical(value[k])]));
  }
  return value;
}
const same = (a, b) => JSON.stringify(canonical(a ?? {})) === JSON.stringify(canonical(b ?? {}));

/** Убирает пустые поля, чтобы «очищенное» и «никогда не заданное» значение совпадали. */
function compact(data) {
  return Object.fromEntries(
    Object.entries(data).filter(([, v]) => v !== '' && v !== false && v != null && !(Array.isArray(v) && !v.length)),
  );
}

function text(value, field, max) {
  if (value == null) return '';
  if (typeof value !== 'string') fail(`${field}: ожидается строка`);
  const s = value.trim();
  if (s.length > max) fail(`${field}: не длиннее ${max} символов`);
  return s;
}

export class ContentStore {
  constructor(db) {
    this.db = db;
  }

  // ---------- Чтение ----------

  draftOverlay() {
    const overlay = emptyOverlay();
    for (const r of this.db.prepare('SELECT item_id, data FROM item_content').all()) overlay.items[r.item_id] = JSON.parse(r.data);
    for (const r of this.db.prepare('SELECT category_id, data FROM category_content').all()) overlay.categories[r.category_id] = JSON.parse(r.data);
    for (const r of this.db.prepare('SELECT key, value FROM settings').all()) overlay.settings[r.key] = JSON.parse(r.value);
    return overlay;
  }

  lastPublication() {
    return this.db.prepare('SELECT * FROM publication ORDER BY id DESC LIMIT 1').get() ?? null;
  }

  publishedOverlay() {
    const p = this.lastPublication();
    return p ? JSON.parse(p.overlay) : emptyOverlay();
  }

  listPublications(limit = 30) {
    return this.db
      .prepare('SELECT id, note, created_at AS createdAt, created_by AS createdBy FROM publication ORDER BY id DESC LIMIT ?')
      .all(limit);
  }

  mediaIndex() {
    const map = new Map();
    for (const r of this.db.prepare('SELECT id, width, height, widths FROM media').all()) {
      map.set(r.id, { id: r.id, width: r.width, height: r.height, widths: JSON.parse(r.widths) });
    }
    return map;
  }

  /** Что изменено в черновике относительно последней публикации. */
  changes() {
    const draft = this.draftOverlay();
    const pub = this.publishedOverlay();
    const out = [];
    for (const kind of ['items', 'categories']) {
      const ids = new Set([...Object.keys(draft[kind]), ...Object.keys(pub[kind])]);
      for (const id of ids) if (!same(draft[kind][id], pub[kind][id])) out.push({ kind: kind === 'items' ? 'item' : 'category', id });
    }
    for (const key of new Set([...Object.keys(draft.settings), ...Object.keys(pub.settings)])) {
      if (!same(draft.settings[key], pub.settings[key])) out.push({ kind: 'setting', id: key });
    }
    return out;
  }

  // ---------- Черновик ----------

  #validPhotos(photos) {
    if (photos == null) return [];
    if (!Array.isArray(photos) || photos.length > 10) fail('photos: список до 10 фото');
    const known = this.db.prepare('SELECT 1 FROM media WHERE id = ?');
    for (const id of photos) if (typeof id !== 'string' || !known.get(id)) fail(`Фото ${id} не найдено`);
    return [...new Set(photos)];
  }

  #upsert(table, key, id, data, user) {
    const clean = compact(data);
    if (!Object.keys(clean).length) {
      this.db.prepare(`DELETE FROM ${table} WHERE ${key} = ?`).run(id);
    } else {
      this.db
        .prepare(`INSERT INTO ${table} (${key}, data, updated_at, updated_by) VALUES (?, ?, ?, ?)
                  ON CONFLICT(${key}) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
        .run(id, JSON.stringify(clean), now(), user ?? null);
    }
    return clean;
  }

  #current(table, key, id) {
    const row = this.db.prepare(`SELECT data FROM ${table} WHERE ${key} = ?`).get(id);
    return row ? JSON.parse(row.data) : {};
  }

  patchItem(itemId, patch, user) {
    const cur = this.#current('item_content', 'item_id', itemId);
    const next = { ...cur };
    if ('title' in patch) next.title = text(patch.title, 'Название', 120);
    if ('description' in patch) next.description = text(patch.description, 'Описание', 1000);
    if ('hidden' in patch) next.hidden = !!patch.hidden;
    if ('badges' in patch) {
      if (!Array.isArray(patch.badges) || patch.badges.some((b) => !BADGES.includes(b))) fail(`Метки: только ${BADGES.join(', ')}`);
      next.badges = [...new Set(patch.badges)];
    }
    if ('photos' in patch) next.photos = this.#validPhotos(patch.photos);
    return this.#upsert('item_content', 'item_id', itemId, next, user);
  }

  patchCategory(categoryId, patch, user) {
    const cur = this.#current('category_content', 'category_id', categoryId);
    const next = { ...cur };
    if ('description' in patch) next.description = text(patch.description, 'Описание', 500);
    if ('hidden' in patch) next.hidden = !!patch.hidden;
    if ('photos' in patch) next.photos = this.#validPhotos(patch.photos).slice(0, 1);
    return this.#upsert('category_content', 'category_id', categoryId, next, user);
  }

  /** Порядок задаётся целиком списком id; позиции, которых нет в списке, остаются в порядке iiko после них. */
  setOrder(kind, ids, user) {
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) fail('Ожидается список id');
    const [table, key] = kind === 'items' ? ['item_content', 'item_id'] : ['category_content', 'category_id'];
    this.db.exec('BEGIN');
    try {
      ids.forEach((id, i) => this.#upsert(table, key, id, { ...this.#current(table, key, id), sort: i }, user));
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  patchSettings(patch) {
    if ('soldOutMode' in patch) {
      if (!SOLD_OUT_MODES.includes(patch.soldOutMode)) fail(`soldOutMode: ${SOLD_OUT_MODES.join(' или ')}`);
      this.db
        .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run('soldOutMode', JSON.stringify(patch.soldOutMode));
    }
    return this.draftOverlay().settings;
  }

  addMedia(m, user) {
    this.db
      .prepare('INSERT INTO media (id, width, height, widths, bytes, original_name, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(m.id, m.width, m.height, JSON.stringify(m.widths), m.bytes, m.originalName ?? null, now(), user ?? null);
    return { id: m.id, width: m.width, height: m.height, widths: m.widths };
  }

  // ---------- Публикация ----------

  publish(user, note = '') {
    const overlay = this.draftOverlay();
    const info = this.db
      .prepare('INSERT INTO publication (overlay, note, created_at, created_by) VALUES (?, ?, ?, ?)')
      .run(JSON.stringify(overlay), text(note, 'Комментарий', 200), now(), user ?? null);
    return Number(info.lastInsertRowid);
  }

  /** Заменяет черновик содержимым оверлея (откат к публикации или отмена правок). */
  #replaceDraft(overlay, user) {
    this.db.exec('BEGIN');
    try {
      this.db.exec('DELETE FROM item_content; DELETE FROM category_content; DELETE FROM settings;');
      for (const [id, data] of Object.entries(overlay.items ?? {})) this.#upsert('item_content', 'item_id', id, data, user);
      for (const [id, data] of Object.entries(overlay.categories ?? {})) this.#upsert('category_content', 'category_id', id, data, user);
      const ins = this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)');
      for (const [k, v] of Object.entries(overlay.settings ?? {})) ins.run(k, JSON.stringify(v));
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  discardDraft(user) {
    this.#replaceDraft(this.publishedOverlay(), user);
  }

  restore(publicationId, user) {
    const p = this.db.prepare('SELECT overlay FROM publication WHERE id = ?').get(publicationId);
    if (!p) fail(`Публикация #${publicationId} не найдена`);
    this.#replaceDraft(JSON.parse(p.overlay), user);
    return this.publish(user, `Откат к публикации #${publicationId}`);
  }
}
