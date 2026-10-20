import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { IikoClient, resolveTargets } from './iiko.js';
import { normalizeExternalMenu } from './normalize.js';
import { demoMenu } from './demo-menu.js';

const sha1 = (s) => createHash('sha1').update(s).digest('hex');

async function writeJsonAtomic(file, data) {
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(data));
  await rename(tmp, file);
}

/**
 * Хранит актуальное меню: забирает его из iiko по расписанию, кладёт на диск
 * (переживает перезапуск и обрыв интернета) и сообщает подписчикам о новой версии.
 */
export class MenuStore extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.menuFile = path.join(config.dataDir, 'menu.json');
    this.mediaDir = path.join(config.dataDir, 'media');
    this.menu = null;
    this.status = { source: config.demo ? 'demo' : 'iiko', lastSyncAt: null, lastSuccessAt: null, lastError: null, syncing: false };
    this.client = config.demo ? null : new IikoClient(config.iiko);
    this.targets = null;
  }

  async init() {
    await mkdir(this.mediaDir, { recursive: true });
    if (!this.config.demo && existsSync(this.menuFile)) {
      try {
        this.menu = JSON.parse(await readFile(this.menuFile, 'utf8'));
        this.status.lastSuccessAt = this.menu.updatedAt;
      } catch (err) {
        console.warn('[sync] не удалось прочитать кеш меню:', err.message);
      }
    }
    await this.sync();
    const ms = this.config.syncIntervalMin * 60 * 1000;
    this.timer = setInterval(() => this.sync(), ms);
    this.timer.unref();
  }

  async sync() {
    if (this.status.syncing) return this.menu;
    this.status.syncing = true;
    this.status.lastSyncAt = new Date().toISOString();
    try {
      const content = this.config.demo ? demoMenu : await this.#fetchFromIiko();
      const version = sha1(JSON.stringify(content)).slice(0, 12);
      if (version !== this.menu?.version) {
        this.menu = {
          version,
          updatedAt: new Date().toISOString(),
          source: this.status.source,
          restaurant: { name: this.config.restaurantName, currency: this.config.currency },
          settings: { idleSeconds: this.config.idleSeconds },
          ...content,
        };
        if (!this.config.demo) await writeJsonAtomic(this.menuFile, this.menu);
        console.log(`[sync] новая версия меню ${version}: ${content.categories.length} категорий`);
        this.emit('updated', this.menu);
      }
      this.status.lastSuccessAt = new Date().toISOString();
      this.status.lastError = null;
    } catch (err) {
      // Меню остаётся прежним (из памяти или с диска) — планшеты продолжают работать.
      this.status.lastError = err.message;
      console.error('[sync] ошибка:', err.message);
      if (/не найден/.test(err.message)) this.targets = null;
    } finally {
      this.status.syncing = false;
    }
    return this.menu;
  }

  async #fetchFromIiko() {
    const cfg = this.config.iiko;
    this.targets ??= await resolveTargets(this.client, cfg);
    const { org, menu } = this.targets;
    const raw = await this.client.menuById({
      externalMenuId: menu.id,
      organizationIds: [org.id],
      priceCategoryId: cfg.priceCategoryId,
      version: cfg.menuVersion,
      language: cfg.language,
    });
    const content = normalizeExternalMenu(raw, { organizationId: org.id });
    if (!content.categories.length) throw new Error('Внешнее меню пустое — проверьте его наполнение и цены в iikoWeb');
    if (this.config.cacheImages) await this.#cacheImages(content);
    return content;
  }

  /** Скачивает фото на сервер и подменяет ссылки на локальные /media/... */
  async #cacheImages(content) {
    const targets = [];
    for (const cat of content.categories) {
      targets.push(cat);
      targets.push(...cat.items);
    }
    const queue = targets.filter((t) => t.image && /^https?:/.test(t.image));
    const worker = async () => {
      for (let t; (t = queue.shift()); ) t.image = await this.#localImage(t.image);
    };
    await Promise.all(Array.from({ length: 4 }, worker));
  }

  async #localImage(url) {
    const ext = (path.extname(new URL(url).pathname).toLowerCase().match(/^\.(jpe?g|png|webp|gif)$/) || ['.jpg'])[0];
    const name = sha1(url).slice(0, 20) + ext;
    const file = path.join(this.mediaDir, name);
    if (existsSync(file)) return `/media/${name}`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(String(res.status));
      await writeFile(file, Buffer.from(await res.arrayBuffer()));
      return `/media/${name}`;
    } catch (err) {
      console.warn(`[sync] фото не скачано (${err.message}): ${url}`);
      return url;
    }
  }
}
