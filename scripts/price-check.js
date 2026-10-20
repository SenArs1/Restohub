// Проверка нюанса: обновляются ли цены во внешнем меню после изменения в номенклатуре iiko.
//
// Сценарий проверки:
//   1. npm run iiko:prices            — снимок «до», заодно список расхождений
//   2. Меняем цену тестового блюда в iikoOffice/iikoWeb (приказ об изменении цен)
//   3. npm run iiko:prices -- --diff  — через 5 / 15 / 60 минут: что изменилось в номенклатуре и во внешнем меню
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../server/config.js';
import { IikoClient, resolveTargets } from '../server/iiko.js';

const dir = path.join(config.dataDir, 'price-snapshots');
const diffMode = process.argv.includes('--diff');
const client = new IikoClient(config.iiko);
const fmt = (v) => (v == null ? '—' : String(v));

function nomenclaturePrices(nom) {
  const map = new Map();
  for (const p of nom.products ?? []) {
    for (const sp of p.sizePrices ?? []) {
      map.set(`${p.id}:${sp.sizeId ?? ''}`, { name: p.name, price: sp.price?.currentPrice ?? null, inMenu: sp.price?.isIncludedInMenu });
    }
  }
  return map;
}

function externalPrices(raw, orgId) {
  const map = new Map();
  for (const cat of raw.itemCategories ?? []) {
    for (const item of cat.items ?? []) {
      for (const s of item.itemSizes ?? []) {
        const p = (s.prices ?? []).find((x) => x.organizationId === orgId) ?? s.prices?.[0];
        map.set(`${item.itemId}:${s.sizeId ?? ''}`, { name: item.name, price: p?.price ?? null });
      }
    }
  }
  return map;
}

try {
  const { org, menu } = await resolveTargets(client, config.iiko);
  const [nom, raw] = await Promise.all([
    client.nomenclature(org.id),
    client.menuById({ externalMenuId: menu.id, organizationIds: [org.id], priceCategoryId: config.iiko.priceCategoryId, version: config.iiko.menuVersion }),
  ]);
  const base = nomenclaturePrices(nom);
  const ext = externalPrices(raw, org.id);

  const snapshot = { at: new Date().toISOString(), organization: org.name, menu: menu.name, items: {} };
  const mismatches = [];
  for (const [key, e] of ext) {
    const b = base.get(key) ?? base.get(`${key.split(':')[0]}:`);
    snapshot.items[key] = { name: e.name, external: e.price, nomenclature: b?.price ?? null };
    if (b && b.price !== e.price) mismatches.push([e.name, b.price, e.price]);
  }

  console.log(`\n${org.name} · внешнее меню «${menu.name}» · позиций: ${ext.size}`);
  if (config.iiko.priceCategoryId) console.log('Внимание: задана категория цен — расхождение с базовой ценой может быть ожидаемым.');
  if (!mismatches.length) console.log('Цены внешнего меню совпадают с номенклатурой ✓');
  else {
    console.log(`\nРасхождения (номенклатура → внешнее меню): ${mismatches.length}`);
    for (const [n, b, e] of mismatches) console.log(`  • ${n}: ${fmt(b)} → ${fmt(e)}`);
  }

  await mkdir(dir, { recursive: true });
  if (diffMode) {
    const files = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort();
    if (!files.length) console.log('\nНет предыдущего снимка — запустите сначала без --diff.');
    else {
      const prev = JSON.parse(await readFile(path.join(dir, files.at(-1)), 'utf8'));
      console.log(`\nИзменения с ${prev.at}:`);
      let changes = 0;
      for (const [key, now] of Object.entries(snapshot.items)) {
        const was = prev.items[key];
        if (!was) continue;
        const nomChanged = was.nomenclature !== now.nomenclature;
        const extChanged = was.external !== now.external;
        if (!nomChanged && !extChanged) continue;
        changes++;
        console.log(`  • ${now.name}: номенклатура ${fmt(was.nomenclature)} → ${fmt(now.nomenclature)}; ` +
          `внешнее меню ${fmt(was.external)} → ${fmt(now.external)}` +
          (nomChanged && !extChanged ? '   ⚠ внешнее меню НЕ обновилось' : ''));
      }
      if (!changes) console.log('  нет изменений');
    }
  }
  const file = path.join(dir, `${snapshot.at.replace(/[:.]/g, '-')}.json`);
  await writeFile(file, JSON.stringify(snapshot, null, 2));
  console.log(`\nСнимок сохранён: ${path.relative(process.cwd(), file)}`);
} catch (err) {
  console.error(`Ошибка: ${err.message}`);
  process.exit(1);
}
