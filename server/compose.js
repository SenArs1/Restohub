// Сборка меню для планшетов: снимок iiko + контент админки + стоп-лист.
// Цены, размеры, вес, КБЖУ и аллергены берутся только из iiko — в админке их не переопределить.

export const BADGES = ['Хит', 'Новинка', 'Сезонное', 'Без глютена', 'Без сахара', 'Веган'];
export const SOLD_OUT_MODES = ['mark', 'hide'];

export const emptyOverlay = () => ({ items: {}, categories: {}, settings: { soldOutMode: 'mark' } });

/** Ссылки на копии фото: основная — JPEG 800 px (или самая большая из меньших), плюс srcset WebP/JPEG. */
export function mediaUrls(media) {
  const widths = [...media.widths].sort((a, b) => a - b);
  const main = widths.filter((w) => w <= 800).at(-1) ?? widths[0];
  const set = (ext) => widths.map((w) => `/media/${media.id}-${w}.${ext} ${w}w`).join(', ');
  return { id: media.id, src: `/media/${media.id}-${main}.jpg`, srcset: set('jpg'), webp: set('webp'), widths, width: media.width, height: media.height };
}

const sortKey = (overlaySort, index) => (Number.isFinite(overlaySort) ? overlaySort : 100000 + index);

/** Стоп-лист как Map<productId, Set<sizeId|''>>: '' — стоп на товар целиком. */
function indexStopList(keys) {
  const map = new Map();
  for (const key of keys) {
    const i = key.indexOf(':');
    const [product, size] = [key.slice(0, i), key.slice(i + 1)];
    if (!map.has(product)) map.set(product, new Set());
    map.get(product).add(size);
  }
  return map;
}

/**
 * Закончился ли размер блюда. Стоп на товар целиком останавливает все размеры.
 * У блюда с одним размером любой стоп по этому товару значит «закончилось»: iiko может прислать
 * sizeId шкалы размеров, даже если во внешнем меню размер один и без sizeId.
 */
function isStopped(stop, itemId, sizeId, singleSize) {
  const sizes = stop.get(String(itemId));
  if (!sizes) return false;
  return sizes.has('') || singleSize || (sizeId != null && sizes.has(String(sizeId)));
}

/**
 * @param snapshot  нормализованное внешнее меню iiko: { name, categories: [{ id, name, items: [...] }] }
 * @param overlay   контент админки (черновик или опубликованный): { items, categories, settings }
 * @param stopList  ключи `${productId}:${sizeId}` с нулевым остатком
 * @param media     Map<mediaId, { id, widths, width, height }>
 */
export function composeMenu({ snapshot, overlay = emptyOverlay(), stopList = [], media = new Map() }) {
  const stop = indexStopList(stopList);
  const soldOutMode = overlay.settings?.soldOutMode === 'hide' ? 'hide' : 'mark';
  const images = (ids) => (ids ?? []).map((id) => media.get(id)).filter(Boolean).map(mediaUrls);

  const categories = [];
  snapshot.categories.forEach((cat, ci) => {
    const co = overlay.categories?.[cat.id] ?? {};
    if (co.hidden) return;

    const items = [];
    cat.items.forEach((item, ii) => {
      const io = overlay.items?.[item.id] ?? {};
      if (io.hidden) return;

      const sizes = item.sizes.map((s) => ({ ...s, soldOut: isStopped(stop, item.id, s.sizeId, false) }));
      const soldOut = sizes.length ? sizes.every((s) => s.soldOut) : isStopped(stop, item.id, item.sizeId, true);
      if (soldOut && soldOutMode === 'hide') return;

      const own = images(io.photos);
      const badges = (io.badges ?? []).filter((b) => BADGES.includes(b));
      items.push({
        ...item,
        name: io.title || item.name,
        description: io.description || item.description,
        image: own[0]?.src ?? item.image,
        images: own,
        tags: [...new Set([...badges, ...item.tags])],
        sizes,
        soldOut,
        _sort: sortKey(io.sort, ii),
      });
    });
    if (!items.length) return;

    items.sort((a, b) => a._sort - b._sort);
    const cover = images(co.photos)[0];
    categories.push({
      id: cat.id,
      name: cat.name,
      description: co.description || cat.description,
      image: cover?.src ?? cat.image,
      items: items.map(({ _sort, ...rest }) => rest),
      _sort: sortKey(co.sort, ci),
    });
  });

  categories.sort((a, b) => a._sort - b._sort);
  return { name: snapshot.name, categories: categories.map(({ _sort, ...rest }) => rest) };
}
