import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { IikoClient, resolveTargets } from './iiko.js';
import { normalizeExternalMenu } from './normalize.js';
import { findPriceMismatches } from './prices.js';
import { demoMenu } from './demo-menu.js';
import { parseStopList } from './stoplist.js';

const sha1 = (s) => createHash('sha1').update(s).digest('hex');

async function writeJsonAtomic(file, data) {
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(data));
  await rename(tmp, file);
}

/**
 * Снимок данных iiko: внешнее меню (по расписанию) и стоп-лист (раз в минуту).
 * Снимок хранится на диске — переживает перезапуск и обрыв интернета.
 * События: 'snapshot' — изменилось меню iiko, 'stoplist' — изменился стоп-лист.
 */
export class IikoSync extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.snapshotFile = path.join(config.dataDir, 'iiko-snapshot.json');
    this.mediaDir = path.join(config.dataDir, 'media');
    this.snapshot = null; // { version, fetchedAt, content }
    this.stopList = [];
    this.status = {
      source: config.demo ? 'demo' : 'iiko', lastSyncAt: null, lastSuccessAt: null, lastError: null, syncing: false,
      priceCheck: null,
      stopList: null,
    };
    this.client = config.demo ? null : new IikoClient(config.iiko);
    this.targets = null;
    this.timers = [];
  }

  async init() {
    await mkdir(this.mediaDir, { recursive: true });
    if (!this.config.demo && existsSync(this.snapshotFile)) {
      try {
        this.snapshot = JSON.parse(await readFile(this.snapshotFile, 'utf8'));
        this.status.lastSuccessAt = this.snapshot.fetchedAt;
      } catch (err) {
        console.warn('[sync] не удалось прочитать снимок iiko:', err.message);
      }
    }
    await this.sync();
    await this.refreshStopList();
    this.timers.push(setInterval(() => this.sync(), this.config.syncIntervalMin * 60 * 1000));
    if (!this.config.demo) this.timers.push(setInterval(() => this.refreshStopList(), this.config.stopListIntervalSec * 1000));
    for (const t of this.timers) t.unref();
  }

  stop() {
    for (const t of this.timers) clearInterval(t);
  }

  async sync() {
    if (this.status.syncing) return this.snapshot;
    this.status.syncing = true;
    this.status.lastSyncAt = new Date().toISOString();
    try {
      const content = this.config.demo ? demoMenu : await this.#fetchFromIiko();
      const version = sha1(JSON.stringify(content)).slice(0, 12);
      if (version !== this.snapshot?.version) {
        this.snapshot = { version, fetchedAt: new Date().toISOString(), content };
        if (!this.config.demo) await writeJsonAtomic(this.snapshotFile, this.snapshot);
        console.log(`[sync] новый снимок iiko ${version}: ${content.categories.length} категорий`);
        this.emit('snapshot', this.snapshot);
      }
      this.status.lastSuccessAt = new Date().toISOString();
      this.status.lastError = null;
    } catch (err) {
      // Снимок остаётся прежним (из памяти или с диска) — планшеты продолжают работать.
      this.status.lastError = err.message;
      console.error('[sync] ошибка:', err.message);
      if (/не найден/.test(err.message)) this.targets = null;
    } finally {
      this.status.syncing = false;
    }
    return this.snapshot;
  }

  /** Стоп-лист. При ошибке оставляем прежний: лучше показать «есть», чем скрыть всё меню. */
  async refreshStopList() {
    if (this.config.demo) return this.stopList;
    try {
      this.targets ??= await resolveTargets(this.client, this.config.iiko);
      const raw = await this.client.stopLists([this.targets.org.id]);
      const next = parseStopList(raw, { terminalGroupId: this.config.iiko.terminalGroupId });
      this.status.stopList = { checkedAt: new Date().toISOString(), count: next.length, error: null };
      if (JSON.stringify(next) !== JSON.stringify(this.stopList)) {
        this.stopList = next;
        console.log(`[stoplist] закончилось позиций: ${next.length}`);
        this.emit('stoplist', next);
      }
    } catch (err) {
      this.status.stopList = { checkedAt: new Date().toISOString(), count: this.stopList.length, error: err.message };
      console.warn('[stoplist] ошибка:', err.message);
    }
    return this.stopList;
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
    await this.#checkPrices(raw, org.id);
    const content = normalizeExternalMenu(raw, { organizationId: org.id });
    if (!content.categories.length) throw new Error('Внешнее меню пустое — проверьте его наполнение и цены в iikoWeb');
    if (this.config.cacheImages) await this.#cacheImages(content);
    return content;
  }

  /** Сверяет цены внешнего меню с номенклатурой. Ошибка сверки не мешает синхронизации меню. */
  async #checkPrices(raw, organizationId) {
    // С категорией цен внешнее меню намеренно отличается от базовых цен — сверять не с чем.
    if (this.config.iiko.priceCategoryId) return;
    const prev = this.status.priceCheck?.mismatches ?? [];
    try {
      const mismatches = findPriceMismatches(raw, await this.client.nomenclature(organizationId), organizationId);
      this.status.priceCheck = { checkedAt: new Date().toISOString(), mismatches, error: null };
      const fresh = mismatches.filter((m) => !prev.some((p) => p.id === m.id && p.size === m.size && p.iikoPrice === m.iikoPrice));
      for (const m of fresh) {
        console.warn(`[prices] ${m.name}${m.size ? ` (${m.size})` : ''}: в iiko ${m.iikoPrice}, во внешнем меню ${m.menuPrice} — обновите цену в карточке блюда`);
      }
    } catch (err) {
      this.status.priceCheck = { checkedAt: new Date().toISOString(), mismatches: prev, error: err.message };
      console.warn('[prices] сверка не удалась:', err.message);
    }
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
