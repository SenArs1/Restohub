// Service worker: офлайн-оболочка приложения, кеш фото и шрифтов.
const SHELL = 'restohub-shell-v2';
const MEDIA = 'restohub-media-v1';
const SHELL_FILES = ['/', '/index.html', '/styles.css', '/app.js', '/icon.svg', '/manifest.webmanifest'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => ![SHELL, MEDIA].includes(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

async function networkFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch {
    return (await cache.match(req)) ?? (req.mode === 'navigate' ? cache.match('/index.html') : Response.error());
  }
}

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok || res.type === 'opaque') cache.put(req, res.clone());
  return res;
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Меню, статус и SSE всегда из сети — офлайн-копию меню хранит само приложение.
  // Админка тоже только из сети: устаревшая копия админки опаснее, чем её отсутствие офлайн.
  if (url.origin === location.origin && (url.pathname.startsWith('/api/') || url.pathname.startsWith('/admin'))) return;

  if (req.destination === 'image' || url.pathname.startsWith('/media/') ||
      url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    e.respondWith(cacheFirst(req, MEDIA));
    return;
  }
  if (url.origin === location.origin) e.respondWith(networkFirst(req, SHELL));
});
