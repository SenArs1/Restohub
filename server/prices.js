// Сверка цен: внешнее меню iikoWeb ↔ номенклатура iiko.
// Внешнее меню не подхватывает новые цены из номенклатуры само — их обновляют вручную
// в карточке блюда, поэтому расхождения нужно показывать персоналу.

const key = (productId, sizeId) => `${productId}:${sizeId ?? ''}`;

/** Цены номенклатуры: Map<productId:sizeId, { name, price }> */
export function nomenclaturePrices(nom) {
  const map = new Map();
  for (const p of nom.products ?? []) {
    if (p.isDeleted) continue;
    for (const sp of p.sizePrices ?? []) {
      map.set(key(p.id, sp.sizeId), { name: p.name, price: sp.price?.currentPrice ?? null });
    }
  }
  return map;
}

/** Цены внешнего меню: Map<itemId:sizeId, { name, size, price, primary }>; primary — размер по умолчанию или единственный */
export function externalPrices(raw, organizationId) {
  const map = new Map();
  for (const cat of raw.itemCategories ?? []) {
    for (const item of cat.items ?? []) {
      const sizes = item.itemSizes ?? [];
      sizes.forEach((s, i) => {
        const p = (s.prices ?? []).find((x) => x.organizationId === organizationId) ?? s.prices?.[0];
        const primary = sizes.length === 1 || !!s.isDefault;
        // Неосновной размер без sizeId не с чем сопоставить в номенклатуре — даём ему свой ключ.
        map.set(key(item.itemId, s.sizeId ?? (primary ? null : `#${i}`)), {
          name: item.name, size: s.sizeName || '', price: p?.price ?? null, primary,
        });
      });
    }
  }
  return map;
}

/**
 * Цена номенклатуры для позиции внешнего меню: точное совпадение по размеру,
 * а для основного размера — ещё и базовая цена товара без размера.
 */
export function lookupNomenclature(base, k, primary) {
  return base.get(k) ?? (primary ? base.get(`${k.split(':')[0]}:`) : undefined);
}

export function findPriceMismatches(raw, nom, organizationId) {
  const base = nomenclaturePrices(nom);
  const mismatches = [];
  for (const [k, e] of externalPrices(raw, organizationId)) {
    const b = lookupNomenclature(base, k, e.primary);
    if (typeof b?.price !== 'number' || typeof e.price !== 'number' || b.price === e.price) continue;
    mismatches.push({ id: k.split(':')[0], name: e.name, size: e.size, menuPrice: e.price, iikoPrice: b.price });
  }
  return mismatches;
}
