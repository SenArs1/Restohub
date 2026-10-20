import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { createReadStream, readFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createHash, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { ROOT } from './config.js';
import { BADGES, composeMenu, mediaUrls } from './compose.js';
import { SESSION_COOKIE } from './auth.js';
import { MAX_UPLOAD_BYTES, processImage } from './media.js';
import { health } from './health.js';
import { cleanupMedia, planMediaCleanup } from './maintenance.js';
import { createBackup, listBackups, verifyBackup } from './backup.js';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.gif': 'image/gif', '.ico': 'image/x-icon',
};

// Библиотеки админки раздаются из node_modules — только эти файлы.
const VENDOR = {
  'preact.mjs': 'node_modules/preact/dist/preact.module.js',
  'hooks.mjs': 'node_modules/preact/hooks/dist/hooks.module.js',
  'htm.mjs': 'node_modules/htm/dist/htm.module.js',
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function json(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-cache', ...headers });
  res.end(JSON.stringify(body));
}

// ---------- Заголовки безопасности ----------

const BASE_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'SAMEORIGIN',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
};

/** CSP для HTML. В админке разрешён только встроенный importmap — по его хешу. */
function contentSecurityPolicy(publicDir) {
  let importmapHash = '';
  try {
    const html = readFileSync(path.join(publicDir, 'admin', 'index.html'), 'utf8');
    const map = html.match(/<script type="importmap">([\s\S]*?)<\/script>/);
    if (map) importmapHash = ` 'sha256-${createHash('sha256').update(map[1]).digest('base64')}'`;
  } catch { /* без админки — без хеша */ }
  const common = [
    "default-src 'self'",
    // Фото iiko, которые не удалось скачать на сервер, показываются по исходной ссылке.
    "img-src 'self' data: https:",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "connect-src 'self'",
    "worker-src 'self'",
    "frame-ancestors 'self'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ];
  return {
    guest: [...common, "script-src 'self'"].join('; '),
    admin: [...common, `script-src 'self'${importmapHash}`].join('; '),
  };
}

async function sendFile(req, res, root, rel, cacheControl, extraHeaders = {}) {
  const file = path.join(root, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(root + path.sep)) return json(res, 403, { error: 'forbidden' });
  try {
    const st = await stat(file);
    if (!st.isFile()) throw new Error('not a file');
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': cacheControl,
      ...extraHeaders,
    });
    if (req.method === 'HEAD') return res.end();
    createReadStream(file).pipe(res);
  } catch {
    json(res, 404, { error: 'not found' });
  }
}

async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, `Файл больше ${Math.round(limit / 1024 / 1024)} МБ`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(req) {
  const buf = await readBody(req, 256 * 1024);
  try {
    return buf.length ? JSON.parse(buf.toString('utf8')) : {};
  } catch {
    throw new HttpError(400, 'Некорректный JSON');
  }
}

const cookies = (req) =>
  Object.fromEntries(
    String(req.headers.cookie ?? '')
      .split(';')
      .map((c) => c.trim().split('='))
      .filter(([k, v]) => k && v)
      .map(([k, v]) => [k, decodeURIComponent(v)]),
  );

/**
 * @param tls — { key, cert } для встроенного HTTPS; без него сервер работает по HTTP
 *              (тогда HTTPS должен обеспечивать обратный прокси, см. README).
 */
export function createApp({ config, sync, content, auth, publisher, tls = null }) {
  const clients = new Set();
  const csp = contentSecurityPolicy(config.publicDir);

  publisher.on('updated', (menu) => {
    const msg = `event: menu\ndata: ${JSON.stringify({ version: menu.version })}\n\n`;
    for (const res of clients) res.write(msg);
  });

  const statusInfo = () => ({
    ...sync.status,
    version: publisher.menu?.version ?? null,
    tablets: clients.size,
    health: health(sync.status, config),
  });

  function isTokenAdmin(req) {
    const given = Buffer.from(String(req.headers['x-admin-token'] ?? ''));
    const expected = Buffer.from(config.adminToken);
    return config.adminToken && given.length === expected.length && timingSafeEqual(given, expected);
  }

  // За обратным прокси (TRUST_PROXY=1) протокол и IP клиента берутся из X-Forwarded-*.
  const isHttps = (req) => !!req.socket.encrypted || (config.trustProxy && String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim() === 'https');
  const clientIp = (req) => (config.trustProxy && String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim()) || req.socket.remoteAddress;

  const sessionUser = (req) => auth.userBySession(cookies(req)[SESSION_COOKIE]);

  /**
   * Защита изменяющих запросов от CSRF вдобавок к SameSite=Strict:
   * заголовок X-Requested-With (его выставляет только наш JS), Origin совпадает с хостом,
   * браузер не помечает запрос как межсайтовый.
   */
  function checkSameOrigin(req) {
    if (req.method === 'GET' || req.method === 'HEAD') return;
    if (req.headers['x-requested-with'] !== 'restohub') throw new HttpError(403, 'Запрос отклонён');
    const site = req.headers['sec-fetch-site'];
    if (site && site !== 'same-origin' && site !== 'none') throw new HttpError(403, 'Запрос с другого сайта отклонён');
    const origin = req.headers.origin;
    if (origin && origin !== 'null') {
      let host;
      try { host = new URL(origin).host; } catch { throw new HttpError(403, 'Запрос отклонён'); }
      const expected = (config.trustProxy && req.headers['x-forwarded-host']) || req.headers.host;
      if (host !== expected) throw new HttpError(403, 'Запрос с другого сайта отклонён');
    }
  }

  function requireUser(req) {
    const user = sessionUser(req);
    if (!user) throw new HttpError(401, 'Нужно войти');
    checkSameOrigin(req);
    return user;
  }

  function sessionCookie(req, token, maxAge) {
    const secure = config.cookieSecure || isHttps(req) ? '; Secure' : '';
    return `${SESSION_COOKIE}=${token ?? ''}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
  }

  function adminState(user) {
    const snapshot = sync.snapshot?.content ?? { name: '', categories: [] };
    const iiko = composeMenu({ snapshot, stopList: sync.stopList });
    const media = Object.fromEntries([...content.mediaIndex()].map(([id, m]) => [id, mediaUrls(m)]));
    return {
      user,
      restaurant: { name: config.restaurantName, currency: config.currency },
      badges: BADGES,
      iiko: iiko.categories,
      draft: content.draftOverlay(),
      media,
      changes: content.changes(),
      publications: content.listPublications(20),
      status: statusInfo(),
    };
  }

  const afterPublish = () => publisher.rebuild();

  // Фото iiko из текущего, запасного и удержанного снимков очистка не трогает.
  async function snapshotsInUse() {
    const list = [sync.snapshot?.content, sync.held?.content];
    try {
      list.push(JSON.parse(await readFile(sync.prevSnapshotFile, 'utf8')).content);
    } catch { /* запасного снимка нет */ }
    return list.filter(Boolean);
  }

  /** Обслуживание — только владелец: очистка фото и резервные копии. */
  function routesMaintenance(routes) {
    const cleanupOpts = async () => ({ db: content.db, mediaDir: sync.mediaDir, snapshots: await snapshotsInUse(), graceHours: config.mediaGraceHours });
    const summary = (plan) => ({
      media: plan.media.length,
      orphanFiles: plan.orphanFiles.length,
      iikoFiles: plan.iikoFiles.length,
      tmpFiles: plan.tmpFiles.length,
      bytes: plan.bytes,
      kept: plan.kept,
      graceHours: config.mediaGraceHours,
    });
    const backupName = (name) => {
      if (!/^restohub-(auto|manual)-\d{8}-\d{6}$/.test(name)) throw new HttpError(400, 'Неверное имя копии');
      return path.join(config.backupDir, name);
    };
    routes.push(
      ['GET', /^\/api\/admin\/maintenance\/media$/, async () => ({ plan: summary(await planMediaCleanup(await cleanupOpts())) }), 'owner'],
      ['POST', /^\/api\/admin\/maintenance\/media\/cleanup$/, async (req, p, user) => {
        const result = await cleanupMedia(await cleanupOpts());
        console.log(`[media] очистка (${user.login}): записей ${result.media.length}, файлов ${result.removedFiles}, ${result.bytes} байт`);
        return { result: { ...summary(result), removedFiles: result.removedFiles } };
      }, 'owner'],
      ['GET', /^\/api\/admin\/backups$/, async () => ({ backups: await listBackups(config.backupDir), dir: config.backupDir }), 'owner'],
      ['POST', /^\/api\/admin\/backups$/, async (req, p, user) => {
        const { name, manifest } = await createBackup({ db: content.db, dataDir: config.dataDir, backupDir: config.backupDir, kind: 'manual' });
        console.log(`[backup] ${name} (${user.login})`);
        return { name, counts: manifest.counts };
      }, 'owner'],
      ['POST', /^\/api\/admin\/backups\/([^/]+)\/verify$/, async (req, [name]) => {
        const { ok, errors, manifest } = await verifyBackup(backupName(name));
        return { ok, errors, counts: manifest?.counts ?? null };
      }, 'owner'],
    );
  }


  // Маршруты админки: [метод, шаблон пути, обработчик(req, params, user)]
  const adminRoutes = [
    ['GET', /^\/api\/admin\/state$/, (req, p, user) => adminState(user)],
    ['PATCH', /^\/api\/admin\/items\/([^/]+)$/, async (req, [id], user) => ({ item: content.patchItem(id, await readJson(req), user.login) })],
    ['PATCH', /^\/api\/admin\/categories\/([^/]+)$/, async (req, [id], user) => ({ category: content.patchCategory(id, await readJson(req), user.login) })],
    ['PUT', /^\/api\/admin\/order$/, async (req, p, user) => {
      const { kind, ids } = await readJson(req);
      if (!['items', 'categories'].includes(kind)) throw new HttpError(400, 'kind: items или categories');
      content.setOrder(kind, ids, user.login);
      return { ok: true };
    }],
    ['PATCH', /^\/api\/admin\/settings$/, async (req) => ({ settings: content.patchSettings(await readJson(req)) }), 'owner'],
    ['POST', /^\/api\/admin\/media$/, async (req, p, user) => {
      if (!String(req.headers['content-type'] ?? '').startsWith('image/')) throw new HttpError(415, 'Загрузите изображение');
      const buf = await readBody(req, MAX_UPLOAD_BYTES);
      const m = await processImage(buf, sync.mediaDir);
      const name = decodeURIComponent(String(req.headers['x-filename'] ?? '')).slice(0, 200);
      const row = content.addMedia({ ...m, originalName: name }, user.login);
      return { media: mediaUrls(row) };
    }],
    ['POST', /^\/api\/admin\/publish$/, async (req, p, user) => {
      const { note } = await readJson(req);
      const id = content.publish(user.login, note);
      afterPublish();
      return { publication: id, version: publisher.menu?.version };
    }],
    ['POST', /^\/api\/admin\/discard$/, (req, p, user) => {
      content.discardDraft(user.login);
      return { ok: true };
    }],
    ['POST', /^\/api\/admin\/publications\/(\d+)\/restore$/, (req, [id], user) => {
      const pub = content.restore(Number(id), user.login);
      afterPublish();
      return { publication: pub, version: publisher.menu?.version };
    }, 'owner'],
    ['POST', /^\/api\/admin\/sync$/, async () => {
      await sync.sync();
      await sync.refreshStopList();
      return { status: statusInfo() };
    }],
    ['POST', /^\/api\/admin\/iiko\/accept-held$/, async () => {
      if (!(await sync.acceptHeld())) throw new HttpError(409, 'Нет удержанного меню');
      return { status: statusInfo() };
    }, 'owner'],
    // Свой пароль может сменить любой пользователь; после смены нужно войти заново.
    ['POST', /^\/api\/admin\/me\/password$/, async (req, p, user) => {
      const { current, next } = await readJson(req);
      await auth.changePassword(user.login, current, next);
      return { ok: true };
    }],
    // Пользователи — только владелец.
    ['GET', /^\/api\/admin\/users$/, () => ({ users: auth.listUsers() }), 'owner'],
    ['POST', /^\/api\/admin\/users$/, async (req) => {
      const { login, role } = await readJson(req);
      return { login: String(login ?? '').toLowerCase(), password: await auth.createUser(String(login ?? ''), role ?? 'manager') };
    }, 'owner'],
    ['POST', /^\/api\/admin\/users\/([^/]+)\/password$/, async (req, [login]) => ({ password: await auth.resetPassword(login) }), 'owner'],
    ['PATCH', /^\/api\/admin\/users\/([^/]+)$/, async (req, [login], user) => {
      const { role } = await readJson(req);
      if (login.toLowerCase() === user.login && role !== user.role) throw new HttpError(400, 'Свою роль менять нельзя');
      auth.setRole(login, role);
      return { users: auth.listUsers() };
    }, 'owner'],
    ['DELETE', /^\/api\/admin\/users\/([^/]+)$/, (req, [login], user) => {
      if (login.toLowerCase() === user.login) throw new HttpError(400, 'Себя удалить нельзя');
      auth.deleteUser(login);
      return { users: auth.listUsers() };
    }, 'owner'],
  ];

  routesMaintenance(adminRoutes);

  /** Маршруты и требуемые роли — для проверки прав в тестах и документации. */
  const routeTable = adminRoutes.map(([method, re, , role]) => ({ method, pattern: re.source, role: role ?? 'manager' }));

  const NO_STORE = { 'Cache-Control': 'no-store' };

  async function handleAdmin(req, res, p) {
    if (p === '/api/admin/login' && req.method === 'POST') {
      checkSameOrigin(req);
      const { login, password } = await readJson(req);
      const { token, user, maxAge } = await auth.login(login, password, clientIp(req));
      return json(res, 200, { user }, { ...NO_STORE, 'Set-Cookie': sessionCookie(req, token, maxAge) });
    }
    if (p === '/api/admin/logout' && req.method === 'POST') {
      checkSameOrigin(req);
      auth.logout(cookies(req)[SESSION_COOKIE]);
      return json(res, 200, { ok: true }, { ...NO_STORE, 'Set-Cookie': sessionCookie(req, null, 0) });
    }
    if (p === '/api/admin/me' && req.method === 'GET') {
      return json(res, 200, { user: sessionUser(req), setupRequired: !auth.hasUsers(), https: isHttps(req) }, NO_STORE);
    }
    for (const [method, re, handler, role] of adminRoutes) {
      const m = p.match(re);
      if (!m || method !== req.method) continue;
      const user = requireUser(req);
      if (role === 'owner' && user.role !== 'owner') throw new HttpError(403, 'Доступно только владельцу');
      return json(res, 200, await handler(req, m.slice(1).map(decodeURIComponent), user), NO_STORE);
    }
    throw new HttpError(404, 'not found');
  }

  const handler = async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    for (const [k, v] of Object.entries(BASE_HEADERS)) res.setHeader(k, v);
    if (isHttps(req)) res.setHeader('Strict-Transport-Security', 'max-age=15552000');
    try {
      if (p.startsWith('/api/admin/')) return await handleAdmin(req, res, p);

      if (p === '/api/menu' && req.method === 'GET') {
        if (url.searchParams.has('preview')) {
          requireUser(req);
          const preview = publisher.preview();
          return preview ? json(res, 200, preview) : json(res, 503, { error: 'Меню ещё не загружено' });
        }
        const menu = publisher.menu;
        if (!menu) return json(res, 503, { error: 'Меню ещё не загружено', status: sync.status });
        const etag = `"${menu.version}"`;
        if (req.headers['if-none-match'] === etag) {
          res.writeHead(304, { ETag: etag });
          return res.end();
        }
        return json(res, 200, menu, { ETag: etag });
      }

      if (p === '/api/status' && req.method === 'GET') return json(res, 200, statusInfo());

      if (p === '/api/events' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        res.write(`retry: 5000\nevent: menu\ndata: ${JSON.stringify({ version: publisher.menu?.version ?? null })}\n\n`);
        clients.add(res);
        const ping = setInterval(() => res.write(': ping\n\n'), 25000);
        req.on('close', () => { clearInterval(ping); clients.delete(res); });
        return;
      }

      if (p === '/api/sync' && req.method === 'POST') {
        if (!isTokenAdmin(req)) return json(res, 401, { error: 'Нужен заголовок X-Admin-Token' });
        await sync.sync();
        await sync.refreshStopList();
        return json(res, sync.status.lastError ? 502 : 200, statusInfo());
      }

      if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'method not allowed' });

      if (p.startsWith('/media/')) {
        return sendFile(req, res, sync.mediaDir, decodeURIComponent(p.slice('/media/'.length)), 'public, max-age=31536000, immutable');
      }
      if (p.startsWith('/admin/vendor/')) {
        const file = VENDOR[p.slice('/admin/vendor/'.length)];
        return file ? sendFile(req, res, ROOT, file, 'public, max-age=86400') : json(res, 404, { error: 'not found' });
      }
      if (p === '/admin' || p === '/admin/') {
        return sendFile(req, res, config.publicDir, 'admin/index.html', 'no-store', { 'Content-Security-Policy': csp.admin, 'X-Robots-Tag': 'noindex' });
      }

      const rel = p === '/' ? 'index.html' : decodeURIComponent(p.slice(1));
      const htmlCsp = rel.endsWith('.html') ? { 'Content-Security-Policy': rel.startsWith('admin/') ? csp.admin : csp.guest } : {};
      return sendFile(req, res, config.publicDir, rel, 'no-cache', htmlCsp);
    } catch (err) {
      const status = err.status ?? 500;
      if (status >= 500) console.error('[http]', req.method, p, err);
      if (!res.headersSent) json(res, status, { error: status >= 500 ? 'Внутренняя ошибка сервера' : err.message });
      else res.end();
    }
  };

  const server = tls ? createHttpsServer(tls, handler) : createServer(handler);
  server.routeTable = routeTable;
  return server;
}
