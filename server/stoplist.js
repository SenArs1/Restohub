// Стоп-лист iiko (/api/1/stop_lists): позиции с нулевым остатком на группе терминалов.
// Положительный остаток — ограниченное количество, блюдо ещё продаётся.

/**
 * @returns отсортированный список ключей `${productId}:${sizeId}` закончившихся позиций
 */
export function parseStopList(response, { terminalGroupId } = {}) {
  const keys = new Set();
  const walk = (node, groupId) => {
    if (Array.isArray(node)) return node.forEach((n) => walk(n, groupId));
    if (!node || typeof node !== 'object') return;
    const gid = node.terminalGroupId ?? groupId;
    if (node.productId && typeof node.balance === 'number') {
      if (node.balance <= 0 && (!terminalGroupId || gid === terminalGroupId)) keys.add(`${node.productId}:${node.sizeId ?? ''}`);
      return;
    }
    for (const v of Object.values(node)) if (v && typeof v === 'object') walk(v, gid);
  };
  walk(response.terminalGroupStopLists ?? [], null);
  return [...keys].sort();
}

/** Группы терминалов, встретившиеся в ответе, — чтобы предупредить, если их несколько, а нужная не выбрана. */
export function stopListGroups(response) {
  const ids = new Set();
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== 'object') return;
    if (node.terminalGroupId) ids.add(node.terminalGroupId);
    for (const v of Object.values(node)) if (v && typeof v === 'object') walk(v);
  };
  walk(response.terminalGroupStopLists ?? []);
  return [...ids].sort();
}
