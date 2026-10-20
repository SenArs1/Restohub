// Restohub — клиент меню для планшетов.
const CACHE_KEY = 'restohub.menu.v1';
const POLL_MS = 5 * 60 * 1000;

const $ = (sel) => document.querySelector(sel);
const els = {
  brand: $('#brandName'), cats: $('#cats'), content: $('#content'), status: $('#status'),
  sheet: $('#sheet'), sheetMedia: $('#sheetMedia'), sheetBody: $('#sheetBody'),
};

let menu = null;
let offline = false;
let openItemId = null;
let spy = null;

// ---------- Утилиты ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const num = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });
const price = (v) => `${num.format(v)} ${esc(menu.restaurant?.currency ?? '₽')}`;
const amount = (v, unit) => (v ? `${num.format(v)} ${unit}` : '');
const initial = (name) => esc((name || '?').trim().charAt(0).toUpperCase());

function media(item, eager = false) {
  const ph = `<div class="placeholder"><span>${initial(item.name)}</span></div>`;
  if (!item.image) return ph;
  return `${ph}<img class="media" src="${esc(item.image)}" alt="" ${eager ? '' : 'loading="lazy"'} decoding="async">`;
}

function storage(action, value) {
  try {
    if (action === 'get') return JSON.parse(localStorage.getItem(CACHE_KEY));
    localStorage.setItem(CACHE_KEY, JSON.stringify(value));
  } catch { return null; }
}

// ---------- Загрузка и синхронизация ----------
async function load() {
  try {
    const res = await fetch('/api/menu', { cache: 'no-store' });
    if (!res.ok) throw new Error(res.status);
    const data = await res.json();
    offline = false;
    if (data.version !== menu?.version) {
      storage('set', data);
      apply(data);
    } else renderStatus();
  } catch {
    offline = true;
    if (!menu) {
      const cached = storage('get');
      if (cached) apply(cached);
      else return showError();
    }
    renderStatus();
  }
}

function apply(data) {
  menu = data;
  const scroll = els.content.scrollTop;
  els.brand.textContent = menu.restaurant?.name ?? 'Меню';
  document.title = `${els.brand.textContent} — меню`;
  render();
  els.content.scrollTop = scroll;
  if (openItemId) {
    const item = findItem(openItemId);
    item ? openItem(item.id) : closeSheet();
  }
  renderStatus();
}

function listen() {
  if ('EventSource' in window) {
    const es = new EventSource('/api/events');
    es.addEventListener('menu', (e) => {
      const { version } = JSON.parse(e.data);
      if (version && version !== menu?.version) load();
      else if (offline) load();
    });
    es.onerror = () => { offline = !navigator.onLine || offline; renderStatus(); };
  }
  setInterval(load, POLL_MS);
  addEventListener('online', load);
  addEventListener('offline', () => { offline = true; renderStatus(); });
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && load());
}

// ---------- Отрисовка ----------
function render() {
  const cats = menu.categories ?? [];
  els.cats.innerHTML = cats
    .map((c, i) => `<button class="cat" data-cat="${esc(c.id)}" aria-current="${i === 0}">${esc(c.name)}<small>${c.items.length}</small></button>`)
    .join('');

  els.content.innerHTML = cats
    .map((c) => `
      <section class="section" id="cat-${esc(c.id)}" data-cat="${esc(c.id)}">
        <div class="section-head"><h2>${esc(c.name)}</h2>${c.description ? `<p>${esc(c.description)}</p>` : ''}</div>
        <div class="grid">${c.items.map(card).join('')}</div>
      </section>`)
    .join('') || '<div class="loading"><p>Меню пока пустое</p></div>';

  setupScrollSpy();
}

function card(item) {
  const tags = item.tags?.length ? `<div class="tags">${item.tags.slice(0, 2).map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>` : '';
  const from = item.sizes?.length > 1 ? 'от ' : '';
  const minPrice = item.sizes?.length ? Math.min(...item.sizes.map((s) => s.price)) : item.price;
  return `
    <button class="card" data-item="${esc(item.id)}">
      <div class="card-media">${media(item)}${tags}</div>
      <div class="card-body">
        <div class="card-name">${esc(item.name)}</div>
        ${item.description ? `<div class="card-desc">${esc(item.description)}</div>` : ''}
        <div class="card-foot">
          <span class="price">${from}${price(minPrice)}</span>
          <span class="weight">${item.sizes?.length > 1 ? '' : amount(item.weight, item.unit)}</span>
        </div>
      </div>
    </button>`;
}

function setActiveCat(id) {
  for (const b of els.cats.querySelectorAll('.cat')) {
    const on = b.dataset.cat === id;
    b.setAttribute('aria-current', on);
    if (on) b.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
}

function setupScrollSpy() {
  spy?.disconnect();
  spy = new IntersectionObserver(
    (entries) => {
      const visible = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
      if (visible[0]) setActiveCat(visible[0].target.dataset.cat);
    },
    { root: els.content, rootMargin: '0px 0px -70% 0px' },
  );
  els.content.querySelectorAll('.section').forEach((s) => spy.observe(s));
}

function renderStatus() {
  if (!offline || !menu) return (els.status.hidden = true);
  const when = new Date(menu.updatedAt).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
  els.status.textContent = `Нет связи. Показано меню от ${when}`;
  els.status.hidden = false;
}

function showError() {
  els.content.innerHTML = '<div class="loading"><p>Не удалось загрузить меню.<br>Проверьте подключение — мы попробуем снова.</p></div>';
  setTimeout(load, 15000);
}

// ---------- Карточка блюда ----------
function findItem(id) {
  for (const c of menu.categories) for (const i of c.items) if (String(i.id) === String(id)) return i;
  return null;
}

function openItem(id) {
  const item = findItem(id);
  if (!item) return;
  openItemId = item.id;
  const n = item.nutrition;
  const fact = (v, label) => (typeof v === 'number' ? `<div class="fact"><b>${num.format(Math.round(v * 10) / 10)}</b><small>${label}</small></div>` : '');

  els.sheetMedia.innerHTML = media(item, true);
  els.sheetBody.innerHTML = `
    <h3 id="sheetTitle">${esc(item.name)}</h3>
    ${item.tags?.length ? `<div class="chips">${item.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>` : ''}
    ${item.description ? `<p class="lead">${esc(item.description)}</p>` : ''}
    ${item.sizes?.length > 1
      ? `<div class="sizes">${item.sizes.map((s) => `<div class="size"><div>${esc(s.name || 'Порция')}<span>${amount(s.weight, item.unit)}</span></div><b>${price(s.price)}</b></div>`).join('')}</div>`
      : `<div class="big-price"><span class="price">${price(item.price)}</span><span class="weight">${amount(item.weight, item.unit)}</span></div>`}
    ${n ? `<div class="label">На 100 ${item.unit === 'мл' ? 'мл' : 'г'}</div><div class="facts">${fact(n.energy, 'ккал')}${fact(n.proteins, 'белки, г')}${fact(n.fats, 'жиры, г')}${fact(n.carbs, 'углеводы, г')}</div>` : ''}
    ${item.allergens?.length ? `<div class="label">Аллергены</div><div class="chips">${item.allergens.map((a) => `<span class="chip">${esc(a)}</span>`).join('')}</div>` : ''}
    <p class="note">Для заказа обратитесь к официанту или на кассу.</p>`;
  els.sheet.hidden = false;
}

function closeSheet() {
  openItemId = null;
  els.sheet.hidden = true;
}

// ---------- Режим киоска ----------
let idleTimer;
function resetIdle() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    closeSheet();
    els.content.scrollTo({ top: 0 });
  }, (menu?.settings?.idleSeconds ?? 90) * 1000);
}

async function keepAwake() {
  try {
    if ('wakeLock' in navigator && document.visibilityState === 'visible') await navigator.wakeLock.request('screen');
  } catch { /* не поддерживается или нет разрешения */ }
}

// ---------- События ----------
els.cats.addEventListener('click', (e) => {
  const b = e.target.closest('.cat');
  if (!b) return;
  setActiveCat(b.dataset.cat);
  document.getElementById(`cat-${b.dataset.cat}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
});
els.content.addEventListener('click', (e) => {
  const c = e.target.closest('.card');
  if (c) openItem(c.dataset.item);
});
els.sheet.addEventListener('click', (e) => e.target.closest('[data-close]') && closeSheet());
addEventListener('keydown', (e) => e.key === 'Escape' && closeSheet());
document.addEventListener('error', (e) => e.target.classList?.contains('media') && e.target.remove(), true);
for (const ev of ['pointerdown', 'scroll', 'keydown']) addEventListener(ev, resetIdle, { capture: true, passive: true });
document.addEventListener('visibilitychange', keepAwake);
addEventListener('contextmenu', (e) => e.preventDefault());

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

await load();
listen();
resetIdle();
keepAwake();
