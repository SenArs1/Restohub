// Service worker Restohub: офлайн-оболочка, предзагрузка фото опубликованного меню, копия меню.
//
// Кеши:
//   SHELL — файлы приложения («сначала сеть», с таймаутом);
//   MEDIA — фото меню. Наполняется по команде приложения (precache) списком фото текущей версии.
//           Старые фото удаляются только после того, как все фото новой версии загружены, —
//           рабочая версия не теряется, даже если загрузка новой прервалась;
//   DATA  — копия опубликованного меню (/offline/menu.json) и статус предзагрузки;
//   FONTS — шрифты.
const SHELL = 'restohub-shell-v3';
const MEDIA = 'restohub-media-v2';
const DATA = 'restohub-data-v1';
const FONTS = 'restohub-fonts-v1';
const SHELL_FILES = ['/', '/index.html', '/styles.css', '/app.js', '/icon.svg', '/manifest.webmanifest'];
const NETWORK_TIMEOUT_MS = 4000;
const PRECACHE_CONCURRENCY = 4;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => ![SHELL, MEDIA, DATA, FONTS].includes(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

/** Сначала сеть, но не дольше NETWORK_TIMEOUT_MS: Wi-Fi без связи с сервером не должен оставлять пустой экран. */
async function networkFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const fromCache = async () => (await cache.match(req, { ignoreSearch: req.mode === 'navigate' }))
    ?? (req.mode === 'navigate' ? cache.match('/index.html') : undefined);
  const network = fetch(req).then((res) => {
    if (res.ok) cache.put(req, res.clone());
    return res;
  });
  const timeout = new Promise((resolve) => setTimeout(resolve, NETWORK_TIMEOUT_MS));
  try {
    const res = await Promise.race([network, timeout]);
    if (res) return res;
    return (await fromCache()) ?? (await network);
  } catch {
    return (await fromCache()) ?? Response.error();
  }
}

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok || res.type === 'opaque') cache.put(req, res.clone()).catch(() => {});
  return res;
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Меню, статус и SSE всегда из сети — копию меню приложение берёт из DATA само.
  // Админка тоже только из сети: устаревшая копия админки опаснее, чем её отсутствие офлайн.
  if (url.origin === location.origin && (url.pathname.startsWith('/api/') || url.pathname.startsWith('/admin'))) return;

  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    e.respondWith(cacheFirst(req, FONTS));
    return;
  }
  if (url.origin === location.origin && url.pathname.startsWith('/media/')) {
    e.respondWith(cacheFirst(req, MEDIA));
    return;
  }
  if (url.origin === location.origin) e.respondWith(networkFirst(req, SHELL));
});

// ---------- Предзагрузка опубликованной версии ----------

let queue = Promise.resolve();

self.addEventListener('message', (e) => {
  if (e.data?.type !== 'precache') return;
  // Команды выполняются по очереди: новая версия не начнёт чистить кеш, пока идёт предыдущая.
  queue = queue.then(() => precache(e.data, e.source)).catch(() => {});
  e.waitUntil(queue);
});

async function precache({ version, urls, menu }, client) {
  const started = Date.now();
  const data = await caches.open(DATA);
  if (menu) {
    await data.put('/offline/menu.json', new Response(JSON.stringify(menu), { headers: { 'Content-Type': 'application/json' } }));
  }
  const cache = await caches.open(MEDIA);
  const list = [...new Set(urls)];
  const pending = [...list];
  let done = 0;
  let failed = 0;
  let quota = false;

  const worker = async () => {
    for (let url; (url = pending.shift()); ) {
      if (quota) return;
      try {
        if (await cache.match(url)) { done++; continue; }
        const res = await fetch(url, { cache: 'no-cache' });
        if (!res.ok) throw new Error(String(res.status));
        await cache.put(url, res);
        done++;
      } catch (err) {
        failed++;
        if (err?.name === 'QuotaExceededError') quota = true;
      }
    }
  };
  await Promise.all(Array.from({ length: PRECACHE_CONCURRENCY }, worker));

  // Удаляем фото прежних версий только когда новая загружена целиком.
  let pruned = 0;
  if (!failed && !quota) {
    const keep = new Set(list.map((u) => new URL(u, self.location.origin).href));
    for (const req of await cache.keys()) {
      if (!keep.has(req.url)) {
        await cache.delete(req);
        pruned++;
      }
    }
  }
  const status = { version, total: list.length, done, failed, pruned, quota, complete: !failed && !quota, at: new Date().toISOString(), ms: Date.now() - started };
  await data.put('/offline/status.json', new Response(JSON.stringify(status), { headers: { 'Content-Type': 'application/json' } }));
  client?.postMessage({ type: 'precache-status', ...status });
}
