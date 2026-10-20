import test from 'node:test';
import assert from 'node:assert/strict';
import { composeMenu, emptyOverlay } from '../server/compose.js';

const item = (id, extra = {}) => ({
  id, sku: null, sizeId: null, name: `Блюдо ${id}`, description: `iiko ${id}`, image: `iiko-${id}.jpg`, price: 100, weight: 100,
  unit: 'г', nutrition: null, sizes: [], allergens: [], tags: [], ...extra,
});
const snapshot = () => ({
  name: 'Меню',
  categories: [
    { id: 'c1', name: 'Торты', description: '', image: null, items: [item('a'), item('b'), item('c')] },
    { id: 'c2', name: 'Напитки', description: '', image: null, items: [item('d', {
      sizes: [{ sizeId: 's', name: 'S', price: 200, weight: 250 }, { sizeId: 'l', name: 'L', price: 260, weight: 400 }],
    })] },
  ],
});
const media = new Map([['m1', { id: 'm1', widths: [400, 800, 1600], width: 2000, height: 1500 }]]);
const names = (menu) => menu.categories.map((c) => `${c.id}:${c.items.map((i) => i.id).join(',')}`);

test('без контента админки меню совпадает с iiko', () => {
  const m = composeMenu({ snapshot: snapshot() });
  assert.deepEqual(names(m), ['c1:a,b,c', 'c2:d']);
  assert.equal(m.categories[0].items[0].image, 'iiko-a.jpg');
  assert.equal(m.categories[0].items[0].soldOut, false);
});

test('контент админки: название, описание, фото, метки, скрытие, порядок', () => {
  const overlay = emptyOverlay();
  overlay.items.a = { title: 'Медовик «Мади»', description: 'Для гостей', photos: ['m1', 'нет-такого'], badges: ['Хит', 'Чужая'], sort: 2 };
  overlay.items.b = { hidden: true };
  overlay.items.c = { sort: 0 };
  overlay.categories.c2 = { sort: 0 };
  const m = composeMenu({ snapshot: snapshot(), overlay, media });
  assert.deepEqual(names(m), ['c2:d', 'c1:c,a']);
  const a = m.categories[1].items[1];
  assert.equal(a.name, 'Медовик «Мади»');
  assert.equal(a.description, 'Для гостей');
  assert.equal(a.price, 100, 'цена только из iiko');
  assert.equal(a.image, '/media/m1-800.jpg');
  assert.equal(a.images.length, 1);
  assert.match(a.images[0].webp, /m1-1600\.webp 1600w/);
  assert.deepEqual(a.tags, ['Хит']);
});

test('категория без видимых блюд и скрытая категория не показываются', () => {
  const overlay = emptyOverlay();
  overlay.items.d = { hidden: true };
  overlay.categories.c1 = { hidden: true };
  assert.deepEqual(composeMenu({ snapshot: snapshot(), overlay }).categories, []);
});

test('стоп-лист: пометка, скрытие, частичный стоп по размеру', () => {
  const marked = composeMenu({ snapshot: snapshot(), stopList: ['a:', 'd:s'] });
  const a = marked.categories[0].items[0];
  const d = marked.categories[1].items[0];
  assert.equal(a.soldOut, true);
  assert.equal(d.soldOut, false, 'закончился только один размер');
  assert.deepEqual(d.sizes.map((s) => s.soldOut), [true, false]);

  const overlay = emptyOverlay();
  overlay.settings.soldOutMode = 'hide';
  const hidden = composeMenu({ snapshot: snapshot(), overlay, stopList: ['a:', 'd:s', 'd:l'] });
  assert.deepEqual(names(hidden), ['c1:b,c']);
});
