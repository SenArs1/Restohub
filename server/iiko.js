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
  constructor({ apiLogin, apiUrl, timeoutMs = 30000 }) {
    if (!apiLogin) throw new Error('IIKO_API_LOGIN не задан');
    this.apiLogin = apiLogin;
    this.apiUrl = apiUrl;
    this.timeoutMs = timeoutMs;
    this.token = null;
    this.tokenAt = 0;
  }

  async #post(path, body, token) {
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

  async getToken(force = false) {
    if (!force && this.token && Date.now() - this.tokenAt < TOKEN_TTL_MS) return this.token;
    const data = await this.#post('/api/1/access_token', { apiLogin: this.apiLogin });
    this.token = data.token;
    this.tokenAt = Date.now();
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

  menuById({ externalMenuId, organizationIds, priceCategoryId, version, language }) {
    return this.call('/api/2/menu/by_id', {
      externalMenuId,
      organizationIds,
      ...(priceCategoryId ? { priceCategoryId } : {}),
      ...(version ? { version } : {}),
      ...(language ? { language } : {}),
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
