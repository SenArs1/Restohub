import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { composeMenu } from './compose.js';

const sha1 = (s) => createHash('sha1').update(s).digest('hex');

/**
 * Меню, которое видят планшеты: снимок iiko + опубликованный контент + стоп-лист.
 * Пересобирается при новом снимке, изменении стоп-листа и публикации; событие 'updated' — новая версия.
 */
export class Publisher extends EventEmitter {
  constructor({ config, sync, content }) {
    super();
    this.config = config;
    this.sync = sync;
    this.content = content;
    this.menu = null;
    sync.on('snapshot', () => this.rebuild());
    sync.on('stoplist', () => this.rebuild());
  }

  #wrap(composed, version) {
    return {
      version,
      updatedAt: new Date().toISOString(),
      source: this.sync.status.source,
      restaurant: { name: this.config.restaurantName, currency: this.config.currency },
      settings: { idleSeconds: this.config.idleSeconds },
      ...composed,
    };
  }

  #compose(overlay) {
    return composeMenu({
      snapshot: this.sync.snapshot.content,
      overlay,
      stopList: this.sync.stopList,
      media: this.content.mediaIndex(),
    });
  }

  rebuild() {
    if (!this.sync.snapshot) return this.menu;
    const composed = this.#compose(this.content.publishedOverlay());
    const version = sha1(JSON.stringify(composed)).slice(0, 12);
    if (version !== this.menu?.version) {
      this.menu = this.#wrap(composed, version);
      console.log(`[publish] версия меню для планшетов ${version}`);
      this.emit('updated', this.menu);
    }
    return this.menu;
  }

  /** Меню по черновику — для предпросмотра в админке, планшетам не рассылается. */
  preview() {
    if (!this.sync.snapshot) return null;
    return this.#wrap(this.#compose(this.content.draftOverlay()), 'preview');
  }
}
