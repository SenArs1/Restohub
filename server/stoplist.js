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
