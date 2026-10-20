import test from 'node:test';
import assert from 'node:assert/strict';
import { parseStopList } from '../server/stoplist.js';

const response = {
  terminalGroupStopLists: [{
    organizationId: 'org',
    items: [
      { terminalGroupId: 'tg1', items: [
        { productId: 'p1', sizeId: null, balance: 0 },
        { productId: 'p2', sizeId: 's2', balance: -1 },
        { productId: 'p3', balance: 5 },
      ] },
      { terminalGroupId: 'tg2', items: [{ productId: 'p4', balance: 0 }] },
    ],
  }],
};

test('стоп-лист: закончившиеся позиции, ограниченный остаток не считается', () => {
  assert.deepEqual(parseStopList(response), ['p1:', 'p2:s2', 'p4:']);
});

test('стоп-лист: фильтр по группе терминалов', () => {
  assert.deepEqual(parseStopList(response, { terminalGroupId: 'tg2' }), ['p4:']);
});

test('стоп-лист: пустой ответ', () => {
  assert.deepEqual(parseStopList({ terminalGroupStopLists: [] }), []);
});
