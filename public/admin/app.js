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
          ${i > 0 && html`<button class="btn small" disabled=${busy} onClick=${() => restore(p)}>Вернуть</button>`}
        </li>`)}</ul>`
      : html`<p class="hint">Публикаций ещё не было: планшеты показывают меню из iiko как есть.</p>`}
  <//>`;
}

function SettingsDrawer({ data, ctx, onClose }) {
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
    <p class="label" style="margin:0 0 10px">Блюдо в стоп-листе iiko</p>
    <label class="radio"><input type="radio" name="sold" checked=${mode === 'mark'} onChange=${() => change('mark')} />
      <span><b>Показывать с пометкой «Закончилось»</b><span class="hint">Гость видит, что блюдо бывает, но сейчас его нет.</span></span></label>
    <label class="radio"><input type="radio" name="sold" checked=${mode === 'hide'} onChange=${() => change('hide')} />
      <span><b>Скрывать</b><span class="hint">Блюдо пропадает с планшетов, пока его не уберут из стоп-листа.</span></span></label>
    <p class="hint" style="margin-top:14px">Стоп-лист проверяется раз в минуту.</p>
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

function Sidebar({ categories, data, sel, ctx, changed, mismatches }) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const flagged = useMemo(
    () => categories.map((c) => ({ ...c, items: c.items.map((i) => ({ ...i, flags: itemFlags(i, data, changed, mismatches) })) })),
    [categories, data],
  );
  const counts = Object.fromEntries(FILTERS.map(([key, , fn]) => [key, flagged.flatMap((c) => c.items).filter((i) => fn(i.flags)).length]));
  const q = query.trim().toLowerCase();
  const test = FILTERS.find(([k]) => k === filter)[2];

  return html`<aside class="sidebar">
    <div class="sidebar-head">
      <input class="search" type="search" placeholder="Поиск блюда" value=${query} onInput=${(e) => setQuery(e.target.value)} />
      <div class="filters">
        ${FILTERS.filter(([k]) => k === 'all' || counts[k] > 0).map(([k, label]) => html`<button class="chip" aria-pressed=${filter === k} onClick=${() => setFilter(k)}>${label}<span class="n">${counts[k]}</span></button>`)}
      </div>
      <button class="btn small" onClick=${() => ctx.select({ type: 'categories' })}>Порядок категорий</button>
    </div>
    <div class="list">
      ${flagged.map((c) => {
        const items = c.items.filter((i) => test(i.flags) && (!q || i.name.toLowerCase().includes(q) || (data.draft.items[i.id]?.title ?? '').toLowerCase().includes(q)));
        if (!items.length && (filter !== 'all' || q)) return null;
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

// ---------- Приложение ----------

function App() {
  const [me, setMe] = useState(undefined);
  const [setupRequired, setSetupRequired] = useState(false);
  const [data, setData] = useState(null);
  const [sel, setSel] = useState(null);
  const [panel, setPanel] = useState(null);
  const [toast, setToast] = useState(null);
  const [syncing, setSyncing] = useState(false);
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
    return () => removeEventListener('beforeunload', onUnload);
  }, []);

  const select = (next) => {
    if (dirtyRef.current && !confirm('Есть несохранённые изменения. Уйти без сохранения?')) return;
    dirtyRef.current = false;
    setSel(next);
  };
  const addMedia = (m) => setData((d) => ({ ...d, media: { ...d.media, [m.id]: m } }));
  const ctx = { reload, notify, select, addMedia, dirtyRef };

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
    setMe(null);
    setData(null);
  };

  return html`<div class="layout">
    <header class="topbar">
      <span class="brand">Restohub<small>${data.restaurant.name}</small></span>
      ${st.lastError
        ? html`<span class="pill bad" title=${st.lastError}>iiko: ошибка</span>`
        : html`<span class="pill" title="Последняя успешная синхронизация">iiko: ${when(st.lastSuccessAt)}</span>`}
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
      <button class="btn" onClick=${logout} title=${`Вы вошли как ${me.login}`}>Выйти</button>
      </div>
    </header>
    <div class=${`main ${sel ? 'has-selection' : ''}`}>
      <${Sidebar} categories=${categories} data=${data} sel=${sel} ctx=${ctx} changed=${changed} mismatches=${mismatches} />
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
