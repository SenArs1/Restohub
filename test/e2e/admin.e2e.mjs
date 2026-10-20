// E2E админки и гостевого меню на десктопе и телефоне (Chromium).
// Сервер Restohub работает против фейкового iiko, поэтому можно воспроизвести расхождение цен,
// сбой iiko и «сокращённое» меню, не трогая настоящий iiko.
// Запуск: npm run e2e:admin  (скриншоты: E2E_SHOTS=<папка>)
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { startFakeIiko } from '../fake-iiko.js';
import { check, createUser, startServer, stopServer } from './helpers.mjs';

const PORT = 8290 + Math.floor(Math.random() * 100);
const shots = process.env.E2E_SHOTS;
if (shots) await mkdir(shots, { recursive: true });
const shot = (page, name) => (shots ? page.screenshot({ path: path.join(shots, `${name}.png`) }) : null);
const cleanups = [];
const iiko = await startFakeIiko({ after: (fn) => cleanups.push(fn) });
iiko.state.extraItems = 15; // 16 блюд — чтобы сработала защита от сокращения меню
const dataDir = await mkdtemp(path.join(tmpdir(), 'rh-e2e-admin-'));
const env = {
  DEMO: '0', DATA_DIR: dataDir, BACKUP_DIR: `${dataDir}-backups`,
  IIKO_API_URL: iiko.url, IIKO_API_LOGIN: 'key', IIKO_CLIENT_SECRET: '', IIKO_APP_ID: '',
  IIKO_ORGANIZATION_ID: '', IIKO_ORGANIZATION_NAME: 'Madi Cake', IIKO_EXTERNAL_MENU_ID: '', IIKO_EXTERNAL_MENU_NAME: 'Madi Cake',
  IIKO_TERMINAL_GROUP_ID: '', IIKO_PRICE_CATEGORY_ID: '',
};
let server;
let browser;
const errors = [];

async function login(ctx, user, password) {
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${user}: ${e.message}`));
  page.on('dialog', (d) => d.accept());
  await page.goto(`${server.base}/admin`);
  await page.fill('#login', user);
  await page.fill('#password', password);
  await page.click('form .btn.primary');
  await page.waitForSelector('.item-row');
  return page;
}
const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

try {
  createUser(dataDir, 'olga', 'owner', 'owner-password-123');
  createUser(dataDir, 'anna', 'manager', 'manager-password-123');
  server = await startServer({ port: PORT, env });
  browser = await chromium.launch();

  console.log('1. Владелец, десктоп: предупреждения');
  const desk = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  let o = await login(desk, 'olga', 'owner-password-123');
  check(await o.$('.warning') === null, 'без проблем — предупреждений нет');
  check(/iiko: (только что|\d+ мин назад)/.test(await o.textContent('.topbar .pill')), 'время синхронизации «… назад»');

  iiko.state.nomPrice = 450; // цену поменяли в iiko, а во внешнем меню — нет
  await o.click('text=Обновить из iiko');
  await o.waitForSelector('.warning.error');
  check((await o.textContent('.warning.error')).includes('Цены расходятся у 1 блюда'), 'красное предупреждение о расхождении цен');
  await shot(o, 'admin-desktop-price-warning');
  await o.click('.warning >> text=Показать блюда');
  check((await o.textContent('.chip[aria-pressed="true"]')).startsWith('Цена расходится'), '«Показать блюда» включает фильтр');
  check((await o.$$('.item-row')).length === 1, 'в списке одно блюдо с расхождением');
  iiko.state.nomPrice = 420;

  iiko.state.down = true;
  await o.click('text=Обновить из iiko');
  await o.waitForSelector('.warning.warn');
  check((await o.$$('.item-row')).length === 1, 'пока iiko недоступен, остаётся последнее известное расхождение');
  check((await o.textContent('.warning.warn')).includes('Ошибка синхронизации с iiko'), 'сбой iiko — жёлтое предупреждение, данные ещё свежие');
  check((await o.getAttribute('.topbar .pill', 'class')).includes('warn'), 'индикатор iiko жёлтый');
  iiko.state.down = false;

  iiko.state.extraItems = 0; // iiko прислал 1 блюдо вместо 16
  await o.click('text=Обновить из iiko');
  await o.waitForSelector('.warning >> text=Применить новое меню');
  check((await o.$$('.item-row')).length === 16, 'расхождение исправлено — фильтр сам вернулся к «Все»');
  check((await (await fetch(`${server.base}/api/menu`)).json()).categories[0].items.length === 16, 'на планшетах прежнее меню (16 блюд)');
  await shot(o, 'admin-desktop-held');

  console.log('2. Менеджер: права');
  const mctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const m = await login(mctx, 'anna', 'manager-password-123');
  check((await m.textContent('.warning >> nth=0')).includes('Подтвердить может владелец'), 'менеджер видит удержанное меню, но не кнопку');
  await m.click('.item-row');
  await m.fill('#title', 'Медовик «Мади»');
  await m.click('.savebar .btn.primary');
  await m.waitForSelector('.toast');
  await m.click('.topbar >> text=Публикация');
  await m.click('.drawer .btn.primary');
  await m.waitForSelector('.alert.ok');
  check((await (await fetch(`${server.base}/api/menu`)).json()).categories[0].items[0].name === 'Медовик «Мади»', 'менеджер опубликовал правку');
  check(await m.$('.history .btn') === null, 'у менеджера нет кнопки «Вернуть»');
  await m.click('.drawer .btn.icon');
  await m.click('.topbar >> text=Настройки');
  check(await m.$eval('input[name="sold"]', (i) => i.disabled), 'настройка стоп-листа недоступна менеджеру');
  check(await m.$('text=Пользователи') === null && await m.$('text=Резервные копии') === null, 'нет разделов владельца');
  await shot(m, 'admin-desktop-manager-settings');

  console.log('3. Владелец: подтверждение меню, пользователи, фото, копии');
  await o.click('.warning >> text=Применить новое меню');
  await o.waitForSelector('.toast');
  check((await (await fetch(`${server.base}/api/menu`)).json()).categories[0].items.length === 1, 'новое меню применено после подтверждения');
  iiko.state.extraItems = 15;
  await o.click('text=Обновить из iiko');

  await o.click('.topbar >> text=Настройки');
  await o.fill('.inline-form input', 'kate');
  await o.click('.inline-form .btn');
  await o.waitForSelector('.reveal code');
  const katePassword = await o.textContent('.reveal code');
  check(katePassword.length >= 12, 'новому пользователю выдан пароль');
  await o.click('.reveal >> text=Готово');
  await o.click('.drawer-section >> text=Проверить');
  await o.waitForSelector('.drawer-section .alert');
  check(/Удалять нечего|Можно удалить/.test(await o.textContent('.drawer-section .alert')), 'проверка неиспользуемых фото');
  await o.click('text=Создать копию сейчас');
  await o.waitForSelector('.drawer-section .history li');
  await o.click('.drawer-section .history li .btn');
  await o.waitForSelector('text=в порядке ✓');
  check(true, 'копия создана и проверена из админки');
  await shot(o, 'admin-desktop-owner-settings');
  await o.click('.drawer .btn.icon');

  const kctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const k = await login(kctx, 'kate', katePassword);
  check(await k.$('.item-row') !== null, 'kate вошла с выданным паролем');
  await k.click('.topbar >> text=Настройки');
  await k.fill('#pw-current', katePassword);
  await k.fill('#pw-next', 'kate-new-password-1');
  await k.fill('#pw-repeat', 'kate-new-password-1');
  await k.click('text=Сменить пароль');
  await k.waitForSelector('#login');
  check(true, 'после смены пароля — экран входа');
  await k.fill('#login', 'kate');
  await k.fill('#password', 'kate-new-password-1');
  await k.click('form .btn.primary');
  await k.waitForSelector('.item-row');
  check(true, 'вход с новым паролем');

  console.log('4. Откат публикации (владелец)');
  await o.reload();
  await o.waitForSelector('.item-row');
  await o.click('.item-row');
  await o.fill('#title', 'Медовик — неудачное название');
  await o.click('.savebar .btn.primary');
  await o.waitForSelector('.toast');
  await o.click('.topbar >> text=Публикация');
  await o.fill('#note', 'ошибка');
  await o.click('.drawer .btn.primary');
  await o.waitForSelector('.alert.ok');
  const menuName = async () => (await (await fetch(`${server.base}/api/menu`)).json()).categories[0].items[0].name;
  check(await menuName() === 'Медовик — неудачное название', 'опубликована ошибочная правка');
  const restore = await o.$$('.history .btn');
  check(restore.length === 1, 'у владельца есть кнопка «Вернуть» у прошлой публикации');
  await restore[0].click();
  await o.waitForSelector('.history li >> text=Откат к публикации');
  check(await menuName() === 'Медовик «Мади»', 'откат вернул на планшеты прошлую версию');
  await o.click('.drawer .btn.icon');

  console.log('5. Телефон 390×844');
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  iiko.state.nomPrice = 450; // чтобы на телефоне было видно предупреждение
  await o.click('text=Обновить из iiko');
  await o.waitForSelector('.warning.error');
  const p = await login(phone, 'olga', 'owner-password-123');
  check(await p.isVisible('.warning.error'), 'предупреждение о ценах видно на телефоне');
  check(await noOverflow(p), 'список: нет горизонтальной прокрутки');
  await shot(p, 'admin-phone-list');
  await p.click('.item-row');
  await p.waitForSelector('#title');
  check(await noOverflow(p), 'редактор: нет горизонтальной прокрутки');
  check(await p.$eval('.savebar', (e) => Math.round(e.getBoundingClientRect().bottom) === innerHeight), 'панель «Сохранить» прижата к низу');
  await shot(p, 'admin-phone-editor');
  await p.click('.back');
  await p.click('.actions >> text=Настройки');
  check(await noOverflow(p), 'настройки: нет горизонтальной прокрутки');
  await shot(p, 'admin-phone-settings');

  console.log('6. Гостевое меню: альбомная, портретная, телефон');
  for (const [name, vp] of [['landscape', { width: 1280, height: 800 }], ['portrait', { width: 800, height: 1280 }], ['phone', { width: 390, height: 844 }]]) {
    const g = await (await browser.newContext({ viewport: vp })).newPage();
    g.on('pageerror', (e) => errors.push(`guest ${name}: ${e.message}`));
    await g.goto(`${server.base}/`);
    await g.waitForSelector('.card');
    check(await noOverflow(g), `гостевое меню ${name}: без горизонтальной прокрутки`);
    await g.click('.card');
    await g.waitForTimeout(400);
    check(await g.isVisible('.sheet-card'), `гостевое меню ${name}: карточка блюда открывается`);
    await shot(g, `guest-${name}`);
  }

  check(errors.length === 0, `ошибок JavaScript нет${errors.length ? `: ${errors.join('; ')}` : ''}`);
  console.log('\nOK: админка и гостевое меню');
} catch (err) {
  console.error(err.message);
  if (server) console.error('--- лог сервера ---\n' + server.log().slice(-3000));
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  await stopServer(server);
  for (const fn of cleanups) await fn();
  await rm(dataDir, { recursive: true, force: true });
  await rm(`${dataDir}-backups`, { recursive: true, force: true });
}
