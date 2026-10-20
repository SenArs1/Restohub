// Клиент iikoCloud API (Transport). Документация: https://api.iiko.help
const TOKEN_TTL_MS = 50 * 60 * 1000; // токен живёт ~60 минут, обновляем заранее

export class IikoError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export class IikoClient {
  constructor({ apiLogin, clientSecret, appId, apiUrl, timeoutMs = 30000 }) {
    if (!apiLogin) throw new Error('IIKO_API_LOGIN не задан');
    this.apiLogin = apiLogin;
    this.clientSecret = clientSecret;
    this.appId = appId;
    this.apiUrl = apiUrl;
    this.timeoutMs = timeoutMs;
    this.token = null;
    this.tokenExpiresAt = 0;
  }

  // Сетевые сбои (обрыв соединения, таймаут) повторяем; HTTP-ошибки iiko — нет.
  async #post(path, body, token, attempt = 1) {
    try {
      return await this.#request(path, body, token);
    } catch (err) {
      if (err instanceof IikoError || attempt >= 3) throw err;
      await new Promise((r) => setTimeout(r, 1000 * attempt));
      return this.#post(path, body, token, attempt + 1);
    }
  }

  async #request(path, body, token) {
    const res = await fetch(this.apiUrl + path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
    if (!res.ok) {
      const msg = data.errorDescription || data.error || data.message || res.statusText;
      throw new IikoError(`iiko ${path}: ${res.status} ${msg}`, { status: res.status, body: data });
    }
    return data;
  }

  // Ключи старого формата (apiLogin) получают токен через /api/1/access_token,
  // ключи нового формата — через /api/v2/access_token: apiKey + clientSecret + appId приложения
  // server-to-server с портала разработчика iiko.
  async getToken(force = false) {
    if (!force && this.token && Date.now() < this.tokenExpiresAt) return this.token;
    let data;
    if (this.clientSecret) {
      if (!this.appId) throw new Error('Для ключа нового формата нужен IIKO_APP_ID — id приложения на портале разработчика iiko');
      data = await this.#post('/api/v2/access_token', { apiKey: this.apiLogin, clientSecret: this.clientSecret, appId: this.appId });
    } else {
      try {
        data = await this.#post('/api/1/access_token', { apiLogin: this.apiLogin });
      } catch (err) {
        if (/api\/v2\/access_token/.test(err.message)) {
          err.message = 'Ключ нового формата: нужны IIKO_CLIENT_SECRET и IIKO_APP_ID (приложение server-to-server на портале разработчика iiko) — ' + err.message;
        }
        throw err;
      }
    }
    this.token = data.token ?? data.accessToken ?? data.access_token;
    if (!this.token) throw new IikoError('iiko: в ответе access_token нет токена', { body: data });
    const ttl = Number(data.expiresIn ?? data.expires_in) * 1000;
    this.tokenExpiresAt = Date.now() + (ttl > 0 ? Math.min(ttl - 5 * 60 * 1000, TOKEN_TTL_MS) : TOKEN_TTL_MS);
    return this.token;
  }

  async call(path, body) {
    try {
      return await this.#post(path, body, await this.getToken());
    } catch (err) {
      if (err.status === 401) return this.#post(path, body, await this.getToken(true));
      throw err;
    }
  }

  async organizations() {
    const data = await this.call('/api/1/organizations', { returnAdditionalInfo: false, includeDisabled: false });
    return data.organizations ?? [];
  }

  /** Список внешних меню и категорий цен: { externalMenus: [{id,name}], priceCategories: [{id,name}] } */
  externalMenus() {
    return this.call('/api/2/menu', {});
  }

  // Без language iiko отвечает 500 Internal Server Error, поэтому он передаётся всегда.
  menuById({ externalMenuId, organizationIds, priceCategoryId, version, language = 'ru' }) {
    return this.call('/api/2/menu/by_id', {
      externalMenuId,
      organizationIds,
      ...(priceCategoryId ? { priceCategoryId } : {}),
      ...(version ? { version } : {}),
      language: language || 'ru',
    });
  }

  nomenclature(organizationId) {
    return this.call('/api/1/nomenclature', { organizationId, startRevision: 0 });
  }
}

const norm = (s) => String(s ?? '').trim().toLowerCase();

/** Находит организацию и внешнее меню по id или названию из конфига. */
export async function resolveTargets(client, cfg) {
  const orgs = await client.organizations();
  const org = cfg.organizationId
    ? orgs.find((o) => o.id === cfg.organizationId)
    : orgs.find((o) => norm(o.name) === norm(cfg.organizationName)) ??
      (orgs.length === 1 ? orgs[0] : undefined);
  if (!org) {
    throw new Error(`Организация не найдена. Доступны: ${orgs.map((o) => `${o.name} (${o.id})`).join(', ') || '—'}`);
  }

  const { externalMenus = [], priceCategories = [] } = await client.externalMenus();
  const menu = cfg.externalMenuId
    ? externalMenus.find((m) => m.id === cfg.externalMenuId) ?? { id: cfg.externalMenuId, name: '?' }
    : externalMenus.find((m) => norm(m.name) === norm(cfg.externalMenuName));
  if (!menu) {
    throw new Error(
      `Внешнее меню «${cfg.externalMenuName}» не найдено. Создайте его в iikoWeb → Внешние заказы → Внешние меню. ` +
        `Сейчас есть: ${externalMenus.map((m) => `${m.name} (${m.id})`).join(', ') || '—'}`,
    );
  }
  return { org, menu, externalMenus, priceCategories };
}
