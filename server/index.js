import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { config } from './config.js';
import { MenuStore } from './sync.js';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.ico': 'image/x-icon',
};

const store = new MenuStore(config);
const clients = new Set();

store.on('updated', (menu) => {
  const msg = `event: menu\ndata: ${JSON.stringify({ version: menu.version })}\n\n`;
  for (const res of clients) res.write(msg);
});

function json(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-cache', ...headers });
  res.end(JSON.stringify(body));
}

async function sendFile(req, res, root, rel, cacheControl) {
  const file = path.join(root, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(root + path.sep)) return json(res, 403, { error: 'forbidden' });
  try {
    const st = await stat(file);
    if (!st.isFile()) throw new Error('not a file');
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': cacheControl,
    });
    if (req.method === 'HEAD') return res.end();
    createReadStream(file).pipe(res);
  } catch {
    json(res, 404, { error: 'not found' });
  }
}

function isAdmin(req) {
  const given = Buffer.from(String(req.headers['x-admin-token'] ?? ''));
  const expected = Buffer.from(config.adminToken);
  return config.adminToken && given.length === expected.length && timingSafeEqual(given, expected);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  if (p === '/api/menu' && req.method === 'GET') {
    if (!store.menu) return json(res, 503, { error: 'Меню ещё не загружено', status: store.status });
    const etag = `"${store.menu.version}"`;
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { ETag: etag });
      return res.end();
    }
    return json(res, 200, store.menu, { ETag: etag });
  }

  if (p === '/api/status' && req.method === 'GET') {
    return json(res, 200, { ...store.status, version: store.menu?.version ?? null, tablets: clients.size });
  }

  if (p === '/api/events' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(`retry: 5000\nevent: menu\ndata: ${JSON.stringify({ version: store.menu?.version ?? null })}\n\n`);
    clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => { clearInterval(ping); clients.delete(res); });
    return;
  }

  if (p === '/api/sync' && req.method === 'POST') {
    if (!isAdmin(req)) return json(res, 401, { error: 'Нужен заголовок X-Admin-Token' });
    await store.sync();
    return json(res, store.status.lastError ? 502 : 200, { ...store.status, version: store.menu?.version ?? null });
  }

  if (p.startsWith('/media/') && (req.method === 'GET' || req.method === 'HEAD')) {
    return sendFile(req, res, store.mediaDir, p.slice('/media/'.length), 'public, max-age=31536000, immutable');
  }

  if (req.method === 'GET' || req.method === 'HEAD') {
    const rel = p === '/' ? 'index.html' : decodeURIComponent(p.slice(1));
    return sendFile(req, res, config.publicDir, rel, 'no-cache');
  }

  json(res, 405, { error: 'method not allowed' });
});

await store.init();
server.listen(config.port, config.host, () => {
  console.log(`Restohub: http://${config.host}:${config.port}  (источник: ${config.demo ? 'демо-данные' : 'iikoCloud'})`);
});
