// Restohub — админка. Preact + htm без сборки.
// Данные iiko (цены, размеры, КБЖУ, наличие) только показываются; редактируется контент поверх них.
import { h, render } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import htm from 'htm';

const html = htm.bind(h);
const MAX_UPLOAD = 20 * 1024 * 1024;
const SMALL_PHOTO = 1200;

// ---------- API ----------

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function api(method, path, body, headers = {}) {
  const isFile = body instanceof Blob;
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: {
      ...(method !== 'GET' ? { 'X-Requested-With': 'restohub' } : {}),
      ...(body !== undefined && !isFile ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : isFile ? body : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error || `Ошибка ${res.status}`);
  return data;
}

// ---------- Утилиты ----------

const num = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });
const when = (iso) => (iso ? new Date(iso).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
const smallest = (m) => m.srcset.split(', ')[0].split(' ')[0];
const mb = (bytes) => `${num.format(Math.round((bytes / 1024 / 1024) * 10) / 10)} МБ`;
/** «только что», «12 мин назад», «3 ч назад», «2 дн назад». */
function ago(iso) {
  if (!iso) return 'никогда';
  const min = Math.floor((Date.now() - Date.parse(iso)) / 60000);
  if (min < 1) return 'только что';
  if (min < 60) return `${min} мин назад`;
  if (min < 48 * 60) return `${Math.floor(min / 60)} ч назад`;
  return `${Math.floor(min / 1440)} дн назад`;
}
const sortKey = (sort, i) => (Number.isFinite(sort) ? sort : 100000 + i);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Категории и блюда в порядке черновика — так же, как их соберёт сервер. */
function orderedCategories(data) {
  const { items, categories } = data.draft;
  return data.iiko
    .map((c, ci) => ({
      ...c,
      _k: sortKey(categories[c.id]?.sort, ci),
      items: c.items.map((it, ii) => ({ ...it, _k: sortKey(items[it.id]?.sort, ii) })).sort((a, b) => a._k - b._k),
    }))
    .sort((a, b) => a._k - b._k);
}

function itemFlags(item, data, changed, mismatches) {
  const d = data.draft.items[item.id] ?? {};
  return {
    noPhoto: !d.photos?.length,
    hidden: !!d.hidden,
    soldOut: !!item.soldOut,
    price: mismatches.has(item.id),
    changed: changed.has(`item:${item.id}`),
  };
}

const FILTERS = [
  ['all', 'Все', () => true],
  ['noPhoto', 'Без фото', (f) => f.noPhoto],
  ['hidden', 'Скрытые', (f) => f.hidden],
  ['soldOut', 'Закончились', (f) => f.soldOut],
  ['price', 'Цена расходится', (f) => f.price],
  ['changed', 'Изменено', (f) => f.changed],
];

function Thumb({ src, name, class: cls = 'thumb' }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  return html`<div class=${cls}>
    ${src && !failed ? html`<img src=${src} alt="" loading="lazy" onError=${() => setFailed(true)} />` : (name || '?').trim().charAt(0).toUpperCase()}
  </div>`;
}

function Toast({ toast }) {
  return toast ? html`<div class=${`toast ${toast.bad ? 'bad' : ''}`} role="status">${toast.text}</div>` : null;
}

// ---------- Вход ----------

function Login({ setupRequired, onLogin }) {
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const { user } = await api('POST', '/api/admin/login', { login, password });
      onLogin(user);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  return html`<div class="login">
    <form onSubmit=${submit}>
      <h1>Restohub</h1>
      <p>Админка электронного меню</p>
      ${location.protocol === 'http:' && !['localhost', '127.0.0.1'].includes(location.hostname) && html`<div class="alert bad">Соединение без HTTPS: пароль передаётся открыто. Используйте адрес https://…</div>`}
      ${setupRequired && html`<div class="alert warn">Пользователей ещё нет. На сервере выполните<br /><code>npm run admin:user -- логин owner</code></div>`}
      ${error && html`<div class="alert bad">${error}</div>`}
      <div class="field"><label for="login">Логин</label><input id="login" type="text" autocomplete="username" value=${login} onInput=${(e) => setLogin(e.target.value)} required /></div>
      <div class="field"><label for="password">Пароль</label><input id="password" type="password" autocomplete="current-password" value=${password} onInput=${(e) => setPassword(e.target.value)} required /></div>
      <button class="btn primary" disabled=${busy}>${busy ? 'Входим…' : 'Войти'}</button>
    </form>
  </div>`;
}

// ---------- Фото ----------

function PhotoManager({ photos, media, max = 10, onChange, onUploaded, notify }) {
  const [uploading, setUploading] = useState(0);
  const [over, setOver] = useState(false);
  const input = useRef();

  const upload = async (files) => {
    let next = [...photos];
    for (const file of files) {
      if (next.length >= max) {
        notify(`Не больше ${max} фото`, true);
        break;
      }
      if (file.size > MAX_UPLOAD) {
        notify(`«${file.name}» больше 20 МБ`, true);
        continue;
      }
      setUploading((n) => n + 1);
      try {
        const { media: m } = await api('POST', '/api/admin/media', file, {
          'Content-Type': file.type || 'image/jpeg',
          'X-Filename': encodeURIComponent(file.name),
        });
        onUploaded(m);
        next = max === 1 ? [m.id] : [...next, m.id];
        onChange(next);
      } catch (err) {
        notify(`«${file.name}»: ${err.message}`, true);
      } finally {
        setUploading((n) => n - 1);
      }
    }
  };

  const move = (i, d) => {
    const next = [...photos];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    onChange(next);
  };

  return html`<div class="photos">
    ${photos.map((id, i) => {
      const m = media[id];
      if (!m) return null;
      return html`<div class="photo" key=${id}>
        <img src=${smallest(m)} alt="" />
        ${i === 0 && max > 1 && html`<span class="main-label">Главное</span>`}
        ${m.width < SMALL_PHOTO && html`<span class="size-warn" title="На планшете фото может выглядеть нечётко">${m.width} px</span>`}
        <div class="tools">
          ${max > 1 && html`
            <button class="btn icon small" title="Левее" disabled=${i === 0} onClick=${() => move(i, -1)}>←</button>
            <button class="btn icon small" title="Правее" disabled=${i === photos.length - 1} onClick=${() => move(i, 1)}>→</button>`}
          <button class="btn icon small danger" title="Убрать" onClick=${() => onChange(photos.filter((p) => p !== id))}>✕</button>
        </div>
      </div>`;
    })}
    ${photos.length < max && html`<label
      class=${`drop ${over ? 'over' : ''}`}
      onDragOver=${(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave=${() => setOver(false)}
      onDrop=${(e) => { e.preventDefault(); setOver(false); upload([...e.dataTransfer.files]); }}
    >
      <input ref=${input} type="file" accept="image/jpeg,image/png,image/webp" multiple=${max > 1}
        onChange=${(e) => { upload([...e.target.files]); e.target.value = ''; }} />
      <span>${uploading ? `Загружаем… (${uploading})` : html`<b>Добавить фото</b><br />перетащите или нажмите<br /><small>JPEG, PNG, WebP до 20 МБ</small>`}</span>
    </label>`}
  </div>`;
}

// ---------- Редактор блюда ----------

function useDirtyGuard(dirtyRef, dirty) {
  useEffect(() => {
    dirtyRef.current = dirty;
    return () => { dirtyRef.current = false; };
  }, [dirty]);
}

function SaveBar({ dirty, busy, onSave, onReset, savedText = 'Все изменения сохранены в черновик' }) {
  return html`<div class="savebar">
    <span class=${`status ${dirty ? 'dirty' : ''}`}>${dirty ? 'Есть несохранённые изменения' : savedText}</span>
    ${dirty && html`<button class="btn" onClick=${onReset} disabled=${busy}>Отменить</button>`}
    <button class="btn primary" onClick=${onSave} disabled=${!dirty || busy}>${busy ? 'Сохраняем…' : 'Сохранить'}</button>
  </div>`;
}

function ItemEditor({ item, category, data, ctx }) {
  const draft = data.draft.items[item.id] ?? {};
  const initial = () => ({
    title: draft.title ?? '', description: draft.description ?? '', hidden: !!draft.hidden,
    badges: draft.badges ?? [], photos: draft.photos ?? [],
  });
  const [form, setForm] = useState(initial);
  const [busy, setBusy] = useState(false);
  useEffect(() => setForm(initial()), [item.id, JSON.stringify(draft)]);
  const dirty = !same(form, initial());
  useDirtyGuard(ctx.dirtyRef, dirty);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const save = async () => {
    setBusy(true);
    try {
      await api('PATCH', `/api/admin/items/${encodeURIComponent(item.id)}`, form);
      await ctx.reload();
      ctx.notify('Сохранено в черновик. Чтобы планшеты увидели — опубликуйте.');
    } catch (err) {
      ctx.notify(err.message, true);
    } finally {
      setBusy(false);
    }
  };

  const mismatch = data.status.priceCheck?.mismatches?.filter((m) => m.id === item.id) ?? [];
  const cur = data.restaurant.currency;
  const nutrition = item.nutrition;

  return html`<div class="editor-page">
    <div class="editor-head">
      <button class="btn icon back" onClick=${() => ctx.select(null)} aria-label="Назад">←</button>
      <h1>${form.title || item.name}</h1>
    </div>
    ${form.hidden && html`<div class="alert warn">Блюдо скрыто на планшетах.</div>`}
    ${item.soldOut && html`<div class="alert warn">В стоп-листе iiko — на планшетах ${data.draft.settings.soldOutMode === 'hide' ? 'скрыто' : 'помечено «Закончилось»'}.</div>`}
    ${mismatch.map((m) => html`<div class="alert bad">Цена расходится: в iiko ${num.format(m.iikoPrice)} ${cur}, во внешнем меню ${num.format(m.menuPrice)} ${cur}. Обновите цену в карточке блюда в iikoWeb → Внешние меню.</div>`)}
    <div class="cols editor-body">
      <div>
        <section class="card">
          <h2>Для гостей</h2>
          <div class="field">
            <label for="title">Название</label>
            <input id="title" type="text" maxlength="120" placeholder=${item.name} value=${form.title} onInput=${(e) => set('title', e.target.value)} />
            <p class="hint">Пусто — берётся из iiko: «${item.name}»</p>
          </div>
          <div class="field">
            <label for="desc">Описание</label>
            <textarea id="desc" maxlength="1000" placeholder=${item.description || 'Например: восемь медовых коржей, сметанный крем, крошка из жжёного мёда'}
              value=${form.description} onInput=${(e) => set('description', e.target.value)} />
            <p class="hint">${item.description ? 'Пусто — берётся описание из iiko.' : 'В iiko описания нет.'} ${form.description.length}/1000</p>
          </div>
          <div class="field">
            <span class="label">Метки</span>
            <div class="badges">
              ${data.badges.map((b) => html`<button type="button" class="chip" aria-pressed=${form.badges.includes(b)}
                onClick=${() => set('badges', form.badges.includes(b) ? form.badges.filter((x) => x !== b) : [...form.badges, b])}>${b}</button>`)}
            </div>
          </div>
          <label class="toggle"><input type="checkbox" checked=${form.hidden} onChange=${(e) => set('hidden', e.target.checked)} /> Скрыть на планшетах</label>
        </section>
        <section class="card">
          <h2>Фото <small>первое — главное, 4:3 смотрится лучше всего</small></h2>
          <${PhotoManager} photos=${form.photos} media=${data.media} onChange=${(v) => set('photos', v)} onUploaded=${ctx.addMedia} notify=${ctx.notify} />
          ${!form.photos.length && item.image && html`<div class="iiko-photo"><${Thumb} src=${item.image} name=${item.name} />Пока своих фото нет, на планшете показывается фото из iiko.</div>`}
        </section>
      </div>
      <aside class="card">
        <h2>Из iiko <small>только просмотр</small></h2>
        <dl class="facts">
          <dt>Категория</dt><dd>${category.name}</dd>
          <dt>Название</dt><dd>${item.name}</dd>
          ${item.sizes?.length > 1
            ? item.sizes.map((s) => html`<dt>${s.name || 'Порция'}</dt><dd>${num.format(s.price)} ${cur}${s.weight ? ` · ${num.format(s.weight)} ${item.unit}` : ''}${s.soldOut ? ' · закончилось' : ''}</dd>`)
            : html`<dt>Цена</dt><dd>${num.format(item.price)} ${cur}</dd>${item.weight && html`<dt>Выход</dt><dd>${num.format(item.weight)} ${item.unit}</dd>`}`}
          ${nutrition && html`<dt>На 100 ${item.unit}</dt><dd>${[
            nutrition.energy != null && `${num.format(nutrition.energy)} ккал`,
            nutrition.proteins != null && `б ${num.format(nutrition.proteins)}`,
            nutrition.fats != null && `ж ${num.format(nutrition.fats)}`,
            nutrition.carbs != null && `у ${num.format(nutrition.carbs)}`,
          ].filter(Boolean).join(' · ')}</dd>`}
          ${item.allergens?.length > 0 && html`<dt>Аллергены</dt><dd>${item.allergens.join(', ')}</dd>`}
          <dt>Наличие</dt><dd>${item.soldOut ? 'стоп-лист' : 'есть'}</dd>
          ${item.sku && html`<dt>Артикул</dt><dd>${item.sku}</dd>`}
        </dl>
        <p class="hint" style="margin-top:12px">Цены, состав и наличие меняются в iiko и подтягиваются автоматически.</p>
      </aside>
    </div>
    <${SaveBar} dirty=${dirty} busy=${busy} onSave=${save} onReset=${() => setForm(initial())} />
  </div>`;
}

// ---------- Редактор категории ----------

function OrderList({ ids, label, thumb, onChange }) {
  const move = (i, d) => {
    const next = [...ids];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    onChange(next);
  };
  return html`<ol class="order">
    ${ids.map((id, i) => html`<li key=${id}>
      <span class="pos">${i + 1}</span>
      <${Thumb} src=${thumb(id)} name=${label(id)} />
      <span>${label(id)}</span>
      <span class="arrows">
        <button class="btn icon small" aria-label="Выше" disabled=${i === 0} onClick=${() => move(i, -1)}>↑</button>
        <button class="btn icon small" aria-label="Ниже" disabled=${i === ids.length - 1} onClick=${() => move(i, 1)}>↓</button>
      </span>
    </li>`)}
  </ol>`;
}

function CategoryEditor({ category, data, ctx }) {
  const draft = data.draft.categories[category.id] ?? {};
  const initial = () => ({ description: draft.description ?? '', hidden: !!draft.hidden, photos: draft.photos ?? [] });
  const initialOrder = () => category.items.map((i) => i.id);
  const [form, setForm] = useState(initial);
  const [order, setOrder] = useState(initialOrder);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setForm(initial()); setOrder(initialOrder()); }, [category.id, JSON.stringify(draft), initialOrder().join()]);
  const formDirty = !same(form, initial());
  const orderDirty = !same(order, initialOrder());
  useDirtyGuard(ctx.dirtyRef, formDirty || orderDirty);
  const byId = Object.fromEntries(category.items.map((i) => [i.id, i]));

  const save = async () => {
    setBusy(true);
    try {
      if (orderDirty) await api('PUT', '/api/admin/order', { kind: 'items', ids: order });
      if (formDirty) await api('PATCH', `/api/admin/categories/${encodeURIComponent(category.id)}`, form);
      await ctx.reload();
      ctx.notify('Сохранено в черновик. Чтобы планшеты увидели — опубликуйте.');
    } catch (err) {
      ctx.notify(err.message, true);
    } finally {
      setBusy(false);
    }
  };

  const itemThumb = (id) => {
    const p = data.draft.items[id]?.photos?.[0];
    return p && data.media[p] ? smallest(data.media[p]) : byId[id]?.image;
  };
  const itemLabel = (id) => data.draft.items[id]?.title || byId[id]?.name;

  return html`<div class="editor-page">
    <div class="editor-head">
      <button class="btn icon back" onClick=${() => ctx.select(null)} aria-label="Назад">←</button>
      <h1>${category.name}</h1>
    </div>
    <div class="cols editor-body">
      <div>
        <section class="card">
          <h2>Категория</h2>
          <div class="field">
            <label for="cdesc">Подзаголовок на планшете</label>
            <input id="cdesc" type="text" maxlength="500" placeholder=${category.description || 'Например: целые торты и порционные кусочки'}
              value=${form.description} onInput=${(e) => setForm({ ...form, description: e.target.value })} />
          </div>
          <label class="toggle"><input type="checkbox" checked=${form.hidden} onChange=${(e) => setForm({ ...form, hidden: e.target.checked })} /> Скрыть категорию на планшетах</label>
        </section>
        <section class="card">
          <h2>Порядок блюд</h2>
          <${OrderList} ids=${order} label=${itemLabel} thumb=${itemThumb} onChange=${setOrder} />
        </section>
      </div>
      <aside class="card">
        <h2>Обложка <small>по желанию</small></h2>
        <${PhotoManager} photos=${form.photos} media=${data.media} max=${1} onChange=${(v) => setForm({ ...form, photos: v })} onUploaded=${ctx.addMedia} notify=${ctx.notify} />
      </aside>
    </div>
    <${SaveBar} dirty=${formDirty || orderDirty} busy=${busy} onSave=${save} onReset=${() => { setForm(initial()); setOrder(initialOrder()); }} />
  </div>`;
}

function CategoryOrderEditor({ categories, ctx }) {
  const initial = () => categories.map((c) => c.id);
  const [order, setOrder] = useState(initial);
  const [busy, setBusy] = useState(false);
  useEffect(() => setOrder(initial()), [initial().join()]);
  const dirty = !same(order, initial());
  useDirtyGuard(ctx.dirtyRef, dirty);
  const byId = Object.fromEntries(categories.map((c) => [c.id, c]));
  const save = async () => {
    setBusy(true);
    try {
      await api('PUT', '/api/admin/order', { kind: 'categories', ids: order });
      await ctx.reload();
      ctx.notify('Порядок сохранён в черновик');
    } catch (err) {
      ctx.notify(err.message, true);
    } finally {
      setBusy(false);
    }
  };
  return html`<div class="editor-page">
    <div class="editor-head">
      <button class="btn icon back" onClick=${() => ctx.select(null)} aria-label="Назад">←</button>
      <h1>Порядок категорий</h1>
    </div>
    <section class="card editor-body" style="max-width:640px">
      <${OrderList} ids=${order} label=${(id) => byId[id]?.name} thumb=${(id) => byId[id]?.image} onChange=${setOrder} />
    </section>
    <${SaveBar} dirty=${dirty} busy=${busy} onSave=${save} onReset=${() => setOrder(initial())} />
  </div>`;
}

// ---------- Публикация и настройки ----------

function Drawer({ title, onClose, children }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, []);
  return html`<div class="overlay" onClick=${(e) => e.target === e.currentTarget && onClose()}>
    <div class="drawer" role="dialog" aria-modal="true" aria-label=${title}>
      <div class="drawer-head"><h1>${title}</h1><button class="btn icon" onClick=${onClose} aria-label="Закрыть">✕</button></div>
      ${children}
    </div>
  </div>`;
}

function PublishDrawer({ data, ctx, onClose }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const names = useMemo(() => {
    const map = {};
    for (const c of data.iiko) {
      map[`category:${c.id}`] = `Категория «${c.name}»`;
      for (const i of c.items) map[`item:${i.id}`] = data.draft.items[i.id]?.title || i.name;
    }
    map['setting:soldOutMode'] = 'Настройка: закончившиеся блюда';
    return map;
  }, [data]);

  const run = async (fn, ok) => {
    setBusy(true);
    try {
      await fn();
      await ctx.reload();
      ctx.notify(ok);
    } catch (err) {
      ctx.notify(err.message, true);
    } finally {
      setBusy(false);
    }
  };
  const publish = () => run(async () => { await api('POST', '/api/admin/publish', { note }); setNote(''); }, 'Опубликовано — планшеты обновятся в течение нескольких секунд');
  const discard = () => confirm('Отменить все неопубликованные изменения? Черновик вернётся к последней публикации.')
    && run(() => api('POST', '/api/admin/discard'), 'Черновик возвращён к последней публикации');
  const restore = (p) => confirm(`Вернуть меню к публикации #${p.id}? Это сразу изменит меню на планшетах.`)
    && run(() => api('POST', `/api/admin/publications/${p.id}/restore`), `Меню возвращено к публикации #${p.id}`);

  return html`<${Drawer} title="Публикация" onClose=${onClose}>
    ${data.changes.length
      ? html`<p class="hint" style="margin-bottom:10px">Изменено в черновике (${data.changes.length}):</p>
        <ul class="changes">${data.changes.map((c) => html`<li><span class="flag edit">${c.kind === 'item' ? 'блюдо' : c.kind === 'category' ? 'категория' : 'настройка'}</span>${names[`${c.kind}:${c.id}`] ?? c.id}</li>`)}</ul>
        <div class="field"><label for="note">Комментарий (по желанию)</label><input id="note" type="text" maxlength="200" placeholder="Например: новые фото тортов" value=${note} onInput=${(e) => setNote(e.target.value)} /></div>
        <div style="display:flex;gap:10px;flex-wrap:wrap">
          <button class="btn primary" onClick=${publish} disabled=${busy}>Опубликовать на планшеты</button>
          <button class="btn danger" onClick=${discard} disabled=${busy || !data.publications.length}>Отменить изменения</button>
        </div>`
      : html`<div class="alert ok">Неопубликованных изменений нет — планшеты показывают актуальный черновик.</div>`}
    <p class="hint" style="margin:16px 0 0">Цены, наличие и новые блюда из iiko появляются на планшетах сами, публиковать их не нужно.</p>
    <h2 style="font:600 24px var(--serif);margin:28px 0 10px">История</h2>
    ${data.publications.length
      ? html`<ul class="history">${data.publications.map((p, i) => html`<li>
          <span class="meta">#${p.id} ${p.note || 'Без комментария'}<small>${when(p.createdAt)} · ${p.createdBy ?? '—'}${i === 0 ? ' · сейчас на планшетах' : ''}</small></span>
          ${i > 0 && ctx.me.role === 'owner' && html`<button class="btn small" disabled=${busy} onClick=${() => restore(p)}>Вернуть</button>`}
        </li>`)}</ul>
        ${ctx.me.role !== 'owner' && data.publications.length > 1 && html`<p class="hint">Вернуть прошлую публикацию может владелец.</p>`}`
      : html`<p class="hint">Публикаций ещё не было: планшеты показывают меню из iiko как есть.</p>`}
  <//>`;
}

function Section({ title, children }) {
  return html`<section class="drawer-section"><h2>${title}</h2>${children}</section>`;
}

function SettingsDrawer({ data, ctx, onClose }) {
  const owner = ctx.me.role === 'owner';
  const mode = data.draft.settings.soldOutMode ?? 'mark';
  const change = async (soldOutMode) => {
    try {
      await api('PATCH', '/api/admin/settings', { soldOutMode });
      await ctx.reload();
      ctx.notify('Сохранено в черновик — вступит в силу после публикации');
    } catch (err) {
      ctx.notify(err.message, true);
    }
  };
  return html`<${Drawer} title="Настройки" onClose=${onClose}>
    <${Section} title="Блюдо в стоп-листе iiko">
      <label class="radio"><input type="radio" name="sold" disabled=${!owner} checked=${mode === 'mark'} onChange=${() => change('mark')} />
        <span><b>Показывать с пометкой «Закончилось»</b><span class="hint">Гость видит, что блюдо бывает, но сейчас его нет.</span></span></label>
      <label class="radio"><input type="radio" name="sold" disabled=${!owner} checked=${mode === 'hide'} onChange=${() => change('hide')} />
        <span><b>Скрывать</b><span class="hint">Блюдо пропадает с планшетов, пока его не уберут из стоп-листа.</span></span></label>
      <p class="hint">Стоп-лист проверяется раз в минуту.${owner ? '' : ' Менять эту настройку может владелец.'}</p>
    <//>
    ${owner && html`<${UsersSection} ctx=${ctx} />`}
    ${owner && html`<${MediaSection} ctx=${ctx} />`}
    ${owner && html`<${BackupsSection} ctx=${ctx} />`}
    <${PasswordSection} ctx=${ctx} />
  <//>`;
}

function PasswordSection({ ctx }) {
  const [form, setForm] = useState({ current: '', next: '', repeat: '' });
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    if (form.next !== form.repeat) return ctx.notify('Новые пароли не совпадают', true);
    setBusy(true);
    try {
      await api('POST', '/api/admin/me/password', { current: form.current, next: form.next });
      ctx.notify('Пароль изменён — войдите с новым паролем');
      ctx.loggedOut();
    } catch (err) {
      ctx.notify(err.message, true);
    } finally {
      setBusy(false);
    }
  };
  const field = (k, label, auto) => html`<div class="field"><label for=${`pw-${k}`}>${label}</label>
    <input id=${`pw-${k}`} type="password" autocomplete=${auto} value=${form[k]} onInput=${(e) => setForm({ ...form, [k]: e.target.value })} required /></div>`;
  return html`<${Section} title=${`Мой пароль (${ctx.me.login})`}>
    <form onSubmit=${submit}>
      ${field('current', 'Текущий пароль', 'current-password')}
      ${field('next', 'Новый пароль (не короче 10 символов)', 'new-password')}
      ${field('repeat', 'Новый пароль ещё раз', 'new-password')}
      <button class="btn" disabled=${busy}>Сменить пароль</button>
      <p class="hint">После смены пароля все сеансы этого пользователя завершаются.</p>
    </form>
  <//>`;
}

/** Показывает пароль один раз. */
function PasswordReveal({ value, onDone }) {
  return html`<div class="alert ok reveal">
    Пароль: <code>${value}</code><br />Передайте его сотруднику — повторно он не показывается.
    <div><button class="btn small" onClick=${() => navigator.clipboard?.writeText(value)}>Скопировать</button> <button class="btn small" onClick=${onDone}>Готово</button></div>
  </div>`;
}

function UsersSection({ ctx }) {
  const [users, setUsers] = useState(null);
  const [form, setForm] = useState({ login: '', role: 'manager' });
  const [secret, setSecret] = useState(null);
  const load = () => api('GET', '/api/admin/users').then((r) => setUsers(r.users)).catch((err) => ctx.notify(err.message, true));
  useEffect(() => { load(); }, []);
  const act = async (fn, ok) => {
    try {
      const r = await fn();
      if (r?.password) setSecret(r.password);
      await load();
      if (ok) ctx.notify(ok);
    } catch (err) {
      ctx.notify(err.message, true);
    }
  };
  const create = (e) => {
    e.preventDefault();
    act(() => api('POST', '/api/admin/users', form), `Пользователь ${form.login} создан`).then(() => setForm({ login: '', role: 'manager' }));
  };
  return html`<${Section} title="Пользователи">
    ${secret && html`<${PasswordReveal} value=${secret} onDone=${() => setSecret(null)} />`}
    ${users && html`<table class="users">
      <thead><tr><th>Логин</th><th>Роль</th><th>Был в админке</th><th></th></tr></thead>
      <tbody>${users.map((u) => html`<tr key=${u.login}>
        <td>${u.login}${u.login === ctx.me.login ? ' (вы)' : ''}</td>
        <td><select disabled=${u.login === ctx.me.login} value=${u.role}
          onChange=${(e) => act(() => api('PATCH', `/api/admin/users/${u.login}`, { role: e.target.value }), 'Роль изменена')}>
          <option value="manager">менеджер</option><option value="owner">владелец</option></select></td>
        <td>${u.lastSeenAt ? ago(u.lastSeenAt) : '—'}</td>
        <td class="row-actions">${u.login !== ctx.me.login && html`
          <button class="btn small" onClick=${() => confirm(`Сбросить пароль ${u.login}? Его сеансы завершатся.`) && act(() => api('POST', `/api/admin/users/${u.login}/password`))}>Новый пароль</button>
          <button class="btn small danger" onClick=${() => confirm(`Удалить пользователя ${u.login}?`) && act(() => api('DELETE', `/api/admin/users/${u.login}`), 'Пользователь удалён')}>Удалить</button>`}</td>
      </tr>`)}</tbody>
    </table>`}
    <form class="inline-form" onSubmit=${create}>
      <input type="text" placeholder="логин (латиница)" value=${form.login} onInput=${(e) => setForm({ ...form, login: e.target.value })} required minlength="3" maxlength="32" />
      <select value=${form.role} onChange=${(e) => setForm({ ...form, role: e.target.value })}><option value="manager">менеджер</option><option value="owner">владелец</option></select>
      <button class="btn">Добавить</button>
    </form>
    <p class="hint">Менеджер: фото, тексты, порядок, публикация. Владелец — ещё откат публикаций, настройки, пользователи, обслуживание.</p>
  <//>`;
}

function MediaSection({ ctx }) {
  const [plan, setPlan] = useState(null);
  const [busy, setBusy] = useState(false);
  const check = async () => {
    setBusy(true);
    try { setPlan((await api('GET', '/api/admin/maintenance/media')).plan); } catch (err) { ctx.notify(err.message, true); } finally { setBusy(false); }
  };
  const total = plan ? plan.media + plan.orphanFiles + plan.iikoFiles + plan.tmpFiles : 0;
  const run = async () => {
    if (!confirm(`Удалить неиспользуемые фото (${mb(plan.bytes)})? Фото из черновика и истории публикаций не удаляются.`)) return;
    setBusy(true);
    try {
      const { result } = await api('POST', '/api/admin/maintenance/media/cleanup');
      ctx.notify(`Удалено файлов: ${result.removedFiles}, освобождено ${mb(result.bytes)}`);
      setPlan(null);
    } catch (err) {
      ctx.notify(err.message, true);
    } finally {
      setBusy(false);
    }
  };
  return html`<${Section} title="Неиспользуемые фото">
    <p class="hint">Удаляются только фото, которых нет ни в черновике, ни в одной публикации из истории (иначе откат показал бы пустые карточки), и загруженные больше ${plan?.graceHours ?? 24} ч назад.</p>
    ${plan && html`<div class=${`alert ${total ? 'warn' : 'ok'}`}>${total
      ? `Можно удалить: фото ${plan.media}, лишних файлов ${plan.orphanFiles + plan.tmpFiles}, старых фото iiko ${plan.iikoFiles} — ${mb(plan.bytes)}. Используются: ${plan.kept.referenced}.`
      : `Удалять нечего. Фото в базе: ${plan.kept.media}, используются: ${plan.kept.referenced}.`}</div>`}
    <div class="row-actions">
      <button class="btn" onClick=${check} disabled=${busy}>Проверить</button>
      ${plan && total > 0 && html`<button class="btn danger" onClick=${run} disabled=${busy}>Удалить</button>`}
    </div>
  <//>`;
}

function BackupsSection({ ctx }) {
  const [list, setList] = useState(null);
  const [busy, setBusy] = useState(false);
  const [checked, setChecked] = useState({});
  const load = () => api('GET', '/api/admin/backups').then(setList).catch((err) => ctx.notify(err.message, true));
  useEffect(() => { load(); }, []);
  const create = async () => {
    setBusy(true);
    try {
      const r = await api('POST', '/api/admin/backups');
      ctx.notify(`Копия ${r.name} создана`);
      await load();
    } catch (err) {
      ctx.notify(err.message, true);
    } finally {
      setBusy(false);
    }
  };
  const verify = async (name) => {
    setChecked({ ...checked, [name]: 'проверяем…' });
    try {
      const r = await api('POST', `/api/admin/backups/${name}/verify`);
      setChecked((c) => ({ ...c, [name]: r.ok ? 'в порядке ✓' : `ошибки: ${r.errors.join('; ')}` }));
    } catch (err) {
      setChecked((c) => ({ ...c, [name]: err.message }));
    }
  };
  return html`<${Section} title="Резервные копии">
    <p class="hint">Автокопия создаётся раз в сутки. Восстановление — на сервере при остановленном Restohub: <code>${'npm run backup -- restore <имя>'}</code> (см. README).</p>
    <div class="row-actions"><button class="btn" onClick=${create} disabled=${busy}>${busy ? 'Создаём…' : 'Создать копию сейчас'}</button></div>
    ${list && (list.backups.length
      ? html`<ul class="history">${list.backups.map((b) => html`<li key=${b.name}>
          <span class="meta">${b.kind === 'auto' ? 'Авто' : 'Вручную'} · ${when(b.createdAt)}<small>${b.error ?? `${mb(b.bytes)} · публикаций ${b.counts.publications}, фото ${b.counts.media}`}${checked[b.name] ? ` · ${checked[b.name]}` : ''}</small></span>
          <button class="btn small" onClick=${() => verify(b.name)}>Проверить</button>
        </li>`)}</ul>`
      : html`<p class="hint">Копий пока нет. Папка: ${list.dir}</p>`)}
  <//>`;
}

function Preview({ onClose }) {
  const [portrait, setPortrait] = useState(false);
  const [size, setSize] = useState({ w: innerWidth, h: innerHeight });
  const frame = useRef();
  useEffect(() => {
    const onResize = () => setSize({ w: innerWidth, h: innerHeight });
    const onKey = (e) => e.key === 'Escape' && onClose();
    addEventListener('resize', onResize);
    addEventListener('keydown', onKey);
    return () => { removeEventListener('resize', onResize); removeEventListener('keydown', onKey); };
  }, []);
  const [w, h2] = portrait ? [800, 1280] : [1280, 800];
  const scale = Math.min((size.w - 56) / w, (size.h - 120) / h2, 1);
  return html`<div class="preview" onClick=${(e) => e.target === e.currentTarget && onClose()}>
    <div class="preview-bar">
      <button class="btn" onClick=${() => setPortrait(!portrait)}>${portrait ? 'Альбомная' : 'Портретная'}</button>
      <button class="btn" onClick=${() => frame.current?.contentWindow?.postMessage({ type: 'restohub:reload' }, location.origin)}>Обновить</button>
      <button class="btn primary" onClick=${onClose}>Закрыть</button>
    </div>
    <div class="preview-frame" style=${`width:${w * scale + 24}px;height:${h2 * scale + 24}px`}>
      <iframe ref=${frame} src="/?preview=1" title="Предпросмотр черновика" style=${`width:${w}px;height:${h2}px;transform:scale(${scale})`} />
    </div>
  </div>`;
}

// ---------- Список ----------

function Sidebar({ categories, data, sel, ctx, changed, mismatches, filter, setFilter }) {
  const [query, setQuery] = useState('');
  const flagged = useMemo(
    () => categories.map((c) => ({ ...c, items: c.items.map((i) => ({ ...i, flags: itemFlags(i, data, changed, mismatches) })) })),
    [categories, data],
  );
  const counts = Object.fromEntries(FILTERS.map(([key, , fn]) => [key, flagged.flatMap((c) => c.items).filter((i) => fn(i.flags)).length]));
  const q = query.trim().toLowerCase();
  // Если у выбранного фильтра не осталось блюд (например, расхождение цен исправили), показываем все.
  useEffect(() => {
    if (filter !== 'all' && !counts[filter]) setFilter('all');
  }, [filter, counts[filter]]);
  const active = filter !== 'all' && !counts[filter] ? 'all' : filter;
  const test = FILTERS.find(([k]) => k === active)[2];

  return html`<aside class="sidebar">
    <div class="sidebar-head">
      <input class="search" type="search" placeholder="Поиск блюда" value=${query} onInput=${(e) => setQuery(e.target.value)} />
      <div class="filters">
        ${FILTERS.filter(([k]) => k === 'all' || counts[k] > 0).map(([k, label]) => html`<button class="chip" aria-pressed=${active === k} onClick=${() => setFilter(k)}>${label}<span class="n">${counts[k]}</span></button>`)}
      </div>
      <button class="btn small" onClick=${() => ctx.select({ type: 'categories' })}>Порядок категорий</button>
    </div>
    <div class="list">
      ${flagged.map((c) => {
        const items = c.items.filter((i) => test(i.flags) && (!q || i.name.toLowerCase().includes(q) || (data.draft.items[i.id]?.title ?? '').toLowerCase().includes(q)));
        if (!items.length && (active !== 'all' || q)) return null;
        const catHidden = data.draft.categories[c.id]?.hidden;
        return html`<div key=${c.id}>
          <button class="cat-row" aria-current=${sel?.type === 'category' && sel.id === c.id} onClick=${() => ctx.select({ type: 'category', id: c.id })}>
            <span>${c.name}${catHidden ? ' · скрыта' : ''}</span>
            ${changed.has(`category:${c.id}`) && html`<span class="flag edit">изменено</span>`}
          </button>
          ${items.map((i) => {
            const d = data.draft.items[i.id] ?? {};
            const photo = d.photos?.[0] && data.media[d.photos[0]];
            const f = i.flags;
            return html`<button key=${i.id} class=${`item-row ${f.hidden ? 'dim' : ''}`} aria-current=${sel?.type === 'item' && sel.id === i.id}
              onClick=${() => ctx.select({ type: 'item', id: i.id })}>
              <${Thumb} src=${photo ? smallest(photo) : i.image} name=${d.title || i.name} />
              <span><div class="name">${d.title || i.name}</div><div class="sub">${num.format(i.price)} ${data.restaurant.currency}</div></span>
              <span class="flags">
                ${f.price && html`<span class="flag bad">цена</span>`}
                ${f.soldOut && html`<span class="flag warn">стоп</span>`}
                ${f.noPhoto && html`<span class="flag">нет фото</span>`}
                ${f.changed && html`<span class="flag edit">изменено</span>`}
              </span>
            </button>`;
          })}
        </div>`;
      })}
    </div>
  </aside>`;
}

// ---------- Предупреждения ----------

function Warnings({ status, ctx, onShowPrices }) {
  const warnings = status.health?.warnings ?? [];
  if (!warnings.length) return html`<div class="warnings"></div>`;
  const accept = async (held) => {
    if (!confirm(`Применить меню из iiko с ${held.count} блюдами вместо ${held.prevCount}? Блюда, которых нет в новом меню, пропадут с планшетов.`)) return;
    try {
      await api('POST', '/api/admin/iiko/accept-held');
      await ctx.reload();
      ctx.notify('Новое меню из iiko применено');
    } catch (err) {
      ctx.notify(err.message, true);
    }
  };
  return html`<div class="warnings" role="alert">
    ${warnings.map((w) => html`<div class=${`warning ${w.level}`} key=${w.code}>
      <span>${w.text}</span>
      ${w.code === 'price_mismatch' && html`<button class="btn small" onClick=${onShowPrices}>Показать блюда</button>`}
      ${w.code === 'held' && (ctx.me.role === 'owner'
        ? html`<button class="btn small" onClick=${() => accept(w.held)}>Применить новое меню</button>`
        : html`<span class="hint">Подтвердить может владелец.</span>`)}
    </div>`)}
  </div>`;
}

// ---------- Приложение ----------

function App() {
  const [me, setMe] = useState(undefined);
  const [setupRequired, setSetupRequired] = useState(false);
  const [data, setData] = useState(null);
  const [sel, setSel] = useState(null);
  const [panel, setPanel] = useState(null);
  const [toast, setToast] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [filter, setFilter] = useState('all');
  const dirtyRef = useRef(false);
  const toastTimer = useRef();

  const notify = (text, bad = false) => {
    clearTimeout(toastTimer.current);
    setToast({ text, bad });
    toastTimer.current = setTimeout(() => setToast(null), bad ? 6000 : 3500);
  };

  const reload = async () => {
    try {
      setData(await api('GET', '/api/admin/state'));
    } catch (err) {
      if (err.status === 401) setMe(null);
      else notify(err.message, true);
    }
  };

  useEffect(() => {
    api('GET', '/api/admin/me').then(({ user, setupRequired: s }) => {
      setSetupRequired(s);
      setMe(user);
      if (user) reload();
    }).catch(() => setMe(null));
    const onUnload = (e) => { if (dirtyRef.current) { e.preventDefault(); e.returnValue = ''; } };
    addEventListener('beforeunload', onUnload);
    // Статус синхронизации обновляется раз в минуту: предупреждение об устаревших данных появится само.
    const poll = setInterval(() => {
      api('GET', '/api/status').then((status) => setData((d) => (d ? { ...d, status } : d))).catch(() => {});
    }, 60000);
    return () => { removeEventListener('beforeunload', onUnload); clearInterval(poll); };
  }, []);

  const select = (next) => {
    if (dirtyRef.current && !confirm('Есть несохранённые изменения. Уйти без сохранения?')) return;
    dirtyRef.current = false;
    setSel(next);
  };
  const addMedia = (m) => setData((d) => ({ ...d, media: { ...d.media, [m.id]: m } }));
  const loggedOut = () => { dirtyRef.current = false; setPanel(null); setMe(null); setData(null); };
  const ctx = { reload, notify, select, addMedia, dirtyRef, me, loggedOut };

  if (me === undefined) return null;
  if (!me) return html`<${Login} setupRequired=${setupRequired} onLogin=${(u) => { setMe(u); reload(); }} /><${Toast} toast=${toast} />`;
  if (!data) return html`<div class="empty"><p>Загружаем…</p></div>`;

  const categories = orderedCategories(data);
  const changed = new Set(data.changes.map((c) => `${c.kind}:${c.id}`));
  const mismatches = new Set((data.status.priceCheck?.mismatches ?? []).map((m) => m.id));
  const st = data.status;

  let editor;
  if (sel?.type === 'item') {
    const category = categories.find((c) => c.items.some((i) => i.id === sel.id));
    const item = category?.items.find((i) => i.id === sel.id);
    editor = item ? html`<${ItemEditor} key=${item.id} item=${item} category=${category} data=${data} ctx=${ctx} />` : null;
  } else if (sel?.type === 'category') {
    const category = categories.find((c) => c.id === sel.id);
    editor = category ? html`<${CategoryEditor} key=${category.id} category=${category} data=${data} ctx=${ctx} />` : null;
  } else if (sel?.type === 'categories') {
    editor = html`<${CategoryOrderEditor} categories=${categories} ctx=${ctx} />`;
  }

  const syncNow = async () => {
    setSyncing(true);
    try {
      await api('POST', '/api/admin/sync');
      await reload();
      notify('Данные iiko обновлены');
    } catch (err) {
      notify(err.message, true);
    } finally {
      setSyncing(false);
    }
  };
  const logout = async () => {
    if (dirtyRef.current && !confirm('Есть несохранённые изменения. Выйти без сохранения?')) return;
    await api('POST', '/api/admin/logout').catch(() => {});
    loggedOut();
  };

  return html`<div class="layout">
    <header class="topbar">
      <span class="brand">Restohub<small>${data.restaurant.name}</small></span>
      <span class=${`pill ${st.health?.menu?.stale ? 'bad' : st.lastError ? 'warn' : ''}`}
        title=${`Последняя успешная синхронизация с iiko: ${when(st.lastSuccessAt)}${st.lastError ? `\nОшибка: ${st.lastError}` : ''}`}>
        iiko: ${ago(st.lastSuccessAt)}</span>
      ${st.stopList?.count > 0 && html`<span class="pill warn">Закончилось: ${st.stopList.count}</span>`}
      <span class="pill hide-narrow" style="background:var(--cream);color:var(--cocoa-soft)">Планшетов онлайн: ${st.tablets}</span>
      <span class="spacer"></span>
      <div class="actions">
      <button class="btn hide-narrow" onClick=${syncNow} disabled=${syncing}>${syncing ? 'Обновляем…' : 'Обновить из iiko'}</button>
      <button class="btn" onClick=${() => setPanel('preview')}>Предпросмотр</button>
      <button class="btn" onClick=${() => setPanel('settings')}>Настройки</button>
      <button class=${`btn ${data.changes.length ? 'primary' : ''}`} onClick=${() => setPanel('publish')}>
        Публикация ${data.changes.length > 0 && html`<span class="count">${data.changes.length}</span>`}
      </button>
      <button class="btn" onClick=${logout} title=${`Вы вошли как ${me.login} (${me.role === 'owner' ? 'владелец' : 'менеджер'})`}>Выйти</button>
      </div>
    </header>
    <${Warnings} status=${st} ctx=${ctx} onShowPrices=${() => { setFilter('price'); select(null); }} />
    <div class=${`main ${sel ? 'has-selection' : ''}`}>
      <${Sidebar} categories=${categories} data=${data} sel=${sel} ctx=${ctx} changed=${changed} mismatches=${mismatches} filter=${filter} setFilter=${setFilter} />
      <main class="editor">
        ${editor ?? html`<div class="empty">
          <h2>Выберите блюдо или категорию</h2>
          <p>Фото, описания и метки сохраняются в черновик.<br />Планшеты увидят их после публикации.</p>
        </div>`}
      </main>
    </div>
    ${panel === 'publish' && html`<${PublishDrawer} data=${data} ctx=${ctx} onClose=${() => setPanel(null)} />`}
    ${panel === 'settings' && html`<${SettingsDrawer} data=${data} ctx=${ctx} onClose=${() => setPanel(null)} />`}
    ${panel === 'preview' && html`<${Preview} onClose=${() => setPanel(null)} />`}
    <${Toast} toast=${toast} />
  </div>`;
}

render(html`<${App} />`, document.getElementById('root'));
