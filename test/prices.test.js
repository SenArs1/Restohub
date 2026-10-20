import test from 'node:test';
import assert from 'node:assert/strict';
import { findPriceMismatches } from '../server/prices.js';
import { externalMenu, ORG } from './fixtures.js';

const nomenclature = (price) => ({
  products: [{ id: 'p-1', name: 'Медовик', sizePrices: [{ sizeId: null, price: { currentPrice: price } }] }],
});

test('сверка цен: совпадение', () => {
  // «Целый» (3900) не сравнивается с базовой ценой товара — с ней сравнивается только основной размер.
  assert.deepEqual(findPriceMismatches(externalMenu(420), nomenclature(420), ORG), []);
});

test('сверка цен: в iiko новая цена, во внешнем меню старая', () => {
  assert.deepEqual(findPriceMismatches(externalMenu(420), nomenclature(450), ORG), [
    { id: 'p-1', name: 'Медовик', size: 'Кусочек', menuPrice: 420, iikoPrice: 450 },
  ]);
});

test('сверка цен: удалённые и отсутствующие в номенклатуре позиции не сравниваются', () => {
  const raw = externalMenu(420);
  assert.deepEqual(findPriceMismatches(raw, { products: [] }, ORG), []);
  const nom = nomenclature(999);
  nom.products[0].isDeleted = true;
  assert.deepEqual(findPriceMismatches(raw, nom, ORG), []);
});

test('сверка цен: размеры сравниваются по sizeId', () => {
  const raw = externalMenu(420);
  const [piece, whole] = raw.itemCategories[0].items[0].itemSizes;
  piece.sizeId = 's-piece';
  whole.sizeId = 's-whole';
  const nom = { products: [{ id: 'p-1', name: 'Медовик', sizePrices: [
    { sizeId: 's-piece', price: { currentPrice: 420 } },
    { sizeId: 's-whole', price: { currentPrice: 4200 } },
  ] }] };
  assert.deepEqual(findPriceMismatches(raw, nom, ORG), [
    { id: 'p-1', name: 'Медовик', size: 'Целый', menuPrice: 3900, iikoPrice: 4200 },
  ]);
});
