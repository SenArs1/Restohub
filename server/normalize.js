// Приводит ответ /api/2/menu/by_id к компактной модели, которую рисуют планшеты.
// Формат внешнего меню у разных версий API немного отличается, поэтому разбор защитный.

function firstUrl(...candidates) {
  for (const c of candidates) {
    if (!c) continue;
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) {
      const s = firstUrl(...c);
      if (s) return s;
    } else if (typeof c === 'object') {
      const s = firstUrl(c.url, c.src, ...Object.values(c));
      if (s) return s;
    }
  }
  return null;
}

const names = (list) =>
  (Array.isArray(list) ? list : []).map((x) => (typeof x === 'string' ? x : x?.name)).filter(Boolean);

function pickPrice(prices, organizationId) {
  if (!Array.isArray(prices) || !prices.length) return null;
  const own = prices.find((p) => p.organizationId === organizationId) ?? prices[0];
  return typeof own?.price === 'number' ? own.price : null;
}

function nutrition(n) {
  if (!n) return null;
  const v = {
    energy: n.energy ?? n.energyFullAmount ?? null,
    proteins: n.proteins ?? n.proteinsFullAmount ?? null,
    fats: n.fats ?? n.fatFullAmount ?? null,
    carbs: n.carbs ?? n.carbohydratesFullAmount ?? null,
  };
  return Object.values(v).some((x) => typeof x === 'number' && x > 0) ? v : null;
}

export function normalizeExternalMenu(raw, { organizationId }) {
  const categories = [];
  for (const cat of raw.itemCategories ?? []) {
    if (cat.isHidden) continue;
    const items = [];
    for (const item of cat.items ?? []) {
      if (item.isHidden) continue;
      const sizes = (item.itemSizes ?? [])
        .filter((s) => !s.isHidden)
        .map((s) => ({
          sizeId: s.sizeId ?? null,
          name: s.sizeName || '',
          isDefault: !!s.isDefault,
          price: pickPrice(s.prices, organizationId),
          weight: s.portionWeightGrams || null,
          image: firstUrl(s.buttonImageUrl, s.buttonImageCroppedUrl),
          nutrition: nutrition(s.nutritionPerHundredGrams),
          unitType: s.measureUnitType ?? null,
        }))
        .filter((s) => s.price !== null);
      if (!sizes.length) continue; // без цены блюдо не продаётся в этой категории цен

      const main = sizes.find((s) => s.isDefault) ?? sizes[0];
      items.push({
        id: item.itemId ?? item.id,
        sku: item.sku ?? null,
        sizeId: main.sizeId,
        name: item.name,
        description: (item.description || '').trim(),
        image: main.image ?? sizes.find((s) => s.image)?.image ?? firstUrl(item.buttonImageUrl),
        price: main.price,
        weight: main.weight,
        unit: /LIT|MILLI/i.test(main.unitType ?? '') || /мл|ml|л$/i.test(item.measureUnit ?? '') ? 'мл' : 'г',
        nutrition: main.nutrition,
        sizes: sizes.length > 1 ? sizes.map(({ sizeId, name, price, weight }) => ({ sizeId, name, price, weight })) : [],
        allergens: names(item.allergens ?? item.allergenGroups),
        tags: names(item.tags).concat(names(item.labels)),
      });
    }
    if (!items.length) continue;
    categories.push({
      id: cat.id,
      name: cat.name,
      description: (cat.description || '').trim(),
      image: firstUrl(cat.headerImageUrl, cat.buttonImageUrl),
      items,
    });
  }
  return { name: raw.name, categories };
}
