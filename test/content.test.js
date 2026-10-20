import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.js';
import { ContentStore } from '../server/content.js';

const store = () => {
  const s = new ContentStore(openDb(':memory:'));
  s.addMedia({ id: 'm1', width: 1600, height: 1200, widths: [400, 800, 1600], bytes: 1 }, 'anna');
  return s;
};

test('черновик → публикация → изменения', () => {
  const s = store();
  assert.deepEqual(s.changes(), []);
  s.patchItem('a', { title: '  Медовик  ', photos: ['m1'], badges: ['Хит'] }, 'anna');
  assert.deepEqual(s.draftOverlay().items.a, { title: 'Медовик', photos: ['m1'], badges: ['Хит'] });
  assert.deepEqual(s.publishedOverlay().items, {}, 'планшеты пока видят старое');
  assert.deepEqual(s.changes(), [{ kind: 'item', id: 'a' }]);

  const id = s.publish('anna', 'Новые фото');
  assert.deepEqual(s.publishedOverlay().items.a.photos, ['m1']);
  assert.deepEqual(s.changes(), []);
  assert.equal(s.listPublications()[0].id, id);
});

test('очищенные поля не считаются изменением', () => {
  const s = store();
  s.patchItem('a', { title: 'X' });
  s.patchItem('a', { title: '' });
  assert.deepEqual(s.changes(), []);
  assert.deepEqual(s.draftOverlay().items, {});
});

test('проверки ввода', () => {
  const s = store();
  assert.throws(() => s.patchItem('a', { photos: ['нет'] }), /не найдено/);
  assert.throws(() => s.patchItem('a', { badges: ['Самое вкусное'] }), /Метки/);
  assert.throws(() => s.patchItem('a', { title: 'x'.repeat(121) }), /120/);
  assert.throws(() => s.patchSettings({ soldOutMode: 'blink' }), /soldOutMode/);
});

test('порядок, отмена черновика и откат к публикации', () => {
  const s = store();
  s.setOrder('items', ['c', 'a']);
  s.patchItem('a', { hidden: true });
  assert.equal(s.draftOverlay().items.a.sort, 1);
  assert.equal(s.draftOverlay().items.a.hidden, true);
  const first = s.publish('anna');

  s.patchItem('a', { hidden: false, description: 'новое' });
  s.discardDraft('anna');
  assert.deepEqual(s.draftOverlay().items.a, { sort: 1, hidden: true }, 'черновик вернулся к публикации');

  s.patchSettings({ soldOutMode: 'hide' });
  s.publish('anna');
  const rollback = s.restore(first, 'anna');
  assert.ok(rollback > first);
  assert.equal(s.publishedOverlay().settings.soldOutMode, 'mark');
  assert.equal(s.listPublications()[0].note, `Откат к публикации #${first}`);
});
