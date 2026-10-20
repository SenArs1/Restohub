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
import { externalPrices, findPriceMismatches, lookupNomenclature, nomenclaturePrices } from '../server/prices.js';

const dir = path.join(config.dataDir, 'price-snapshots');
const diffMode = process.argv.includes('--diff');
const client = new IikoClient(config.iiko);
const fmt = (v) => (v == null ? '—' : String(v));

try {
  const { org, menu } = await resolveTargets(client, config.iiko);
  const [nom, raw] = await Promise.all([
    client.nomenclature(org.id),
    client.menuById({ externalMenuId: menu.id, organizationIds: [org.id], priceCategoryId: config.iiko.priceCategoryId, version: config.iiko.menuVersion, language: config.iiko.language }),
  ]);
  const base = nomenclaturePrices(nom);
  const snapshot = { at: new Date().toISOString(), organization: org.name, menu: menu.name, items: {} };
  for (const [key, e] of externalPrices(raw, org.id)) {
    snapshot.items[key] = { name: e.name, external: e.price, nomenclature: lookupNomenclature(base, key, e.primary)?.price ?? null };
  }
  const mismatches = findPriceMismatches(raw, nom, org.id);

  console.log(`\n${org.name} · внешнее меню «${menu.name}» · позиций: ${Object.keys(snapshot.items).length}`);
  if (config.iiko.priceCategoryId) console.log('Внимание: задана категория цен — расхождение с базовой ценой может быть ожидаемым.');
  if (!mismatches.length) console.log('Цены внешнего меню совпадают с номенклатурой ✓');
  else {
    console.log(`\nРасхождения (номенклатура → внешнее меню): ${mismatches.length}`);
    for (const m of mismatches) console.log(`  • ${m.name}${m.size ? ` (${m.size})` : ''}: ${fmt(m.iikoPrice)} → ${fmt(m.menuPrice)}`);
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
