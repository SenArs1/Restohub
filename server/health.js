// Состояние данных iiko для админки и /status.html: свежесть меню и стоп-листа и список предупреждений.
// Уровни: 'error' — гости могут видеть неверные данные; 'warn' — требует внимания.

const minutesSince = (iso, now) => (iso ? Math.floor((now - Date.parse(iso)) / 60000) : null);

/** Порог устаревания меню: явно заданный или три интервала синхронизации, но не меньше 15 минут. */
export const menuStaleAfter = (config) => config.staleAfterMin || Math.max(3 * config.syncIntervalMin, 15);
/** Порог устаревания стоп-листа: пять интервалов проверки, но не меньше 5 минут. */
export const stopListStaleAfter = (config) => Math.max(Math.ceil((5 * config.stopListIntervalSec) / 60), 5);

export function health(status, config, now = Date.now()) {
  const warnings = [];
  const add = (level, code, text, extra = {}) => warnings.push({ level, code, text, ...extra });
  const demo = status.source === 'demo';

  const menuAge = minutesSince(status.lastSuccessAt, now);
  const menuStale = !demo && (menuAge === null || menuAge >= menuStaleAfter(config));
  const sl = status.stopList;
  const stopAge = minutesSince(sl?.lastSuccessAt, now);
  const stopStale = !demo && (stopAge === null || stopAge >= stopListStaleAfter(config));

  if (!demo && !status.lastSuccessAt) {
    add('error', 'no_menu', 'Меню из iiko ещё ни разу не загружено — планшеты не получат меню до первой успешной синхронизации.');
  } else if (menuStale) {
    add('error', 'menu_stale', `Данные iiko устарели: последняя успешная синхронизация ${menuAge} мин назад. Планшеты показывают последнее сохранённое меню; цены могли измениться.`);
  }
  if (status.held) {
    add('error', 'held', `iiko прислал меню с ${status.held.count} блюдами вместо ${status.held.prevCount}. Оно не применено — планшеты показывают прежнее меню.`, { held: status.held });
  } else if (status.lastError) {
    add(menuStale ? 'error' : 'warn', 'iiko_error', `Ошибка синхронизации с iiko: ${status.lastError}`);
  }

  if (!demo && sl?.error) {
    add(stopStale ? 'error' : 'warn', 'stoplist_error', `Стоп-лист не обновляется: ${sl.error}${stopAge !== null ? ` (последний успешный — ${stopAge} мин назад)` : ''}. Действует последний полученный стоп-лист.`);
  } else if (!demo && stopStale && sl) {
    add('warn', 'stoplist_stale', `Стоп-лист давно не обновлялся (${stopAge ?? '—'} мин).`);
  }
  if (!config.iiko?.terminalGroupId && (sl?.groups?.length ?? 0) > 1) {
    add('warn', 'terminal_groups', `В стоп-листе ${sl.groups.length} группы терминалов, а IIKO_TERMINAL_GROUP_ID не задан — на планшетах учитываются стопы всех групп.`);
  }

  const pc = status.priceCheck;
  if (pc?.mismatches?.length) {
    add('error', 'price_mismatch', `Цены расходятся у ${pc.mismatches.length} ${plural(pc.mismatches.length, 'блюда', 'блюд', 'блюд')}: на планшетах цена из внешнего меню, а в iiko уже другая. Обновите цены в карточках блюд во внешнем меню iikoWeb.`, { count: pc.mismatches.length });
  }
  if (pc?.error) add('warn', 'price_check_error', `Сверка цен не выполнена: ${pc.error}`);

  return {
    menu: { lastSuccessAt: status.lastSuccessAt, ageMin: menuAge, stale: menuStale, staleAfterMin: menuStaleAfter(config) },
    stopList: { lastSuccessAt: sl?.lastSuccessAt ?? null, ageMin: stopAge, stale: stopStale, staleAfterMin: stopListStaleAfter(config) },
    warnings,
  };
}

function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}
