// Шаги 1–2 плана: проверяем доступ к iikoCloud, организацию Madi Cake и наличие внешнего меню.
// Запуск: npm run iiko:check
import { config } from '../server/config.js';
import { IikoClient } from '../server/iiko.js';

const cfg = config.iiko;
if (!cfg.apiLogin) {
  console.error('Заполните IIKO_API_LOGIN в .env (iikoWeb → Настройки → Облачное API → API-ключ)');
  process.exit(1);
}

const client = new IikoClient(cfg);
const ok = (s) => console.log(`  ✓ ${s}`);
const no = (s) => console.log(`  ✗ ${s}`);

try {
  console.log(`\n1) Токен (${cfg.apiUrl})`);
  await client.getToken();
  ok('API-ключ принят');

  console.log('\n2) Организации, доступные ключу');
  const orgs = await client.organizations();
  for (const o of orgs) console.log(`  • ${o.name}  id=${o.id}`);
  const org = orgs.find((o) => o.id === cfg.organizationId) ??
    orgs.find((o) => o.name?.trim().toLowerCase() === cfg.organizationName.toLowerCase());
  org ? ok(`организация: ${org.name}`) : no(`не нашли «${cfg.organizationName}» — укажите IIKO_ORGANIZATION_ID`);

  console.log('\n3) Внешние меню (iikoWeb → Внешние заказы → Внешние меню)');
  const { externalMenus = [], priceCategories = [] } = await client.externalMenus();
  for (const m of externalMenus) console.log(`  • ${m.name}  id=${m.id}`);
  const menu = externalMenus.find((m) => m.id === cfg.externalMenuId) ??
    externalMenus.find((m) => m.name?.trim().toLowerCase() === cfg.externalMenuName.toLowerCase());
  menu ? ok(`внешнее меню: ${menu.name}`) : no(`внешнее меню «${cfg.externalMenuName}» не найдено — создайте его в iikoWeb`);

  if (org) {
    const nom = await client.nomenclature(org.id);
    const dishes = (nom.products ?? []).filter((p) => !p.isDeleted && ['Dish', 'Good'].includes(p.type));
    console.log(`\n   Номенклатура в облаке: групп ${nom.groups?.length ?? 0}, блюд и товаров ${dishes.length}`);
    if (!dishes.length) no('номенклатура пустая — внешнему меню не из чего брать блюда; проверьте, что iikoRMS выгружает её в облако');
  }

  if (org) {
    const tg = await client.call('/api/1/terminal_groups', { organizationIds: [org.id] });
    const groups = (tg.terminalGroups ?? []).flatMap((g) => g.items ?? []);
    console.log(`\n   Группы терминалов (для стоп-листа): ${groups.length}`);
    for (const g of groups) console.log(`  • ${g.name}  id=${g.id}`);
    if (groups.length > 1 && !cfg.terminalGroupId) no('групп несколько — укажите IIKO_TERMINAL_GROUP_ID, иначе стоп-листы всех групп объединяются');
  }

  console.log('\n4) Категории цен');
  if (!priceCategories.length) console.log('  — нет (используются базовые цены)');
  for (const p of priceCategories) console.log(`  • ${p.name}  id=${p.id}`);

  if (org && menu) {
    console.log('\n5) Пробная загрузка меню');
    const raw = await client.menuById({
      externalMenuId: menu.id, organizationIds: [org.id], priceCategoryId: cfg.priceCategoryId,
      version: cfg.menuVersion, language: cfg.language,
    });
    const cats = raw.itemCategories ?? [];
    const items = cats.flatMap((c) => c.items ?? []);
    const withImg = items.filter((i) => (i.itemSizes ?? []).some((s) => s.buttonImageUrl || s.buttonImageCroppedUrl));
    const noPrice = items.filter((i) => !(i.itemSizes ?? []).some((s) => (s.prices ?? []).some((p) => typeof p.price === 'number')));
    (items.length ? ok : no)(`${cats.length} категорий, ${items.length} блюд, с фото: ${withImg.length}`);
    if (!items.length) no('внешнее меню пустое — добавьте в него категории и блюда в iikoWeb и сохраните/опубликуйте');
    if (noPrice.length) no(`без цены (на планшетах будут скрыты): ${noPrice.map((i) => i.name).join(', ')}`);

    console.log('\nДобавьте в .env:');
    console.log(`IIKO_ORGANIZATION_ID=${org.id}\nIIKO_EXTERNAL_MENU_ID=${menu.id}`);
  }
} catch (err) {
  console.error(`\nОшибка: ${err.message}`);
  if (err.body) console.error(JSON.stringify(err.body, null, 2));
  process.exit(1);
}
