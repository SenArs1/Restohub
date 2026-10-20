import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeExternalMenu } from '../server/normalize.js';
import { externalMenu, ORG } from './fixtures.js';

test('normalizeExternalMenu: цены, размеры, скрытые позиции', () => {
  const m = normalizeExternalMenu(externalMenu(), { organizationId: ORG });
  assert.equal(m.categories.length, 1, 'пустая категория скрыта');
  const [item] = m.categories[0].items;
  assert.equal(m.categories[0].items.length, 1, 'скрытые и без цены отброшены');
  assert.equal(item.price, 420);
  assert.equal(item.weight, 150);
  assert.equal(item.image, 'IMG');
  assert.deepEqual(item.sizes.map((s) => s.price), [420, 3900]);
  assert.deepEqual(item.allergens, ['Глютен']);
  assert.deepEqual(item.tags, ['Хит']);
  assert.equal(item.nutrition.energy, 398);
});

test('normalizeExternalMenu: миллилитры по measureUnitType', () => {
  const raw = externalMenu();
  raw.itemCategories[0].items[0].itemSizes[0].measureUnitType = 'MILLILITER';
  const [item] = normalizeExternalMenu(raw, { organizationId: ORG }).categories[0].items;
  assert.equal(item.unit, 'мл');
});
