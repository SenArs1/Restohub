import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { processImage } from '../server/media.js';

const photo = (width, height, opts = {}) =>
  sharp({ create: { width, height, channels: 3, background: '#e8b4b8' } }).jpeg().withMetadata(opts).toBuffer();

test('фото: копии 400/800/1600 в WebP и JPEG, без метаданных', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'rh-media-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const m = await processImage(await photo(4000, 3000), dir);
  assert.deepEqual(m.widths, [400, 800, 1600]);
  assert.equal(m.width, 4000);
  assert.equal((await readdir(dir)).length, 6);
  assert.deepEqual((await processImage(await photo(1000, 750), dir)).widths, [400, 800, 1000]);
  const out = await sharp(path.join(dir, `${m.id}-800.jpg`)).metadata();
  assert.equal(out.width, 800);
  assert.equal(out.height, 600);
  assert.equal(out.exif, undefined, 'EXIF удалён');
});

test('фото: поворот по EXIF и без увеличения маленьких', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'rh-media-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const m = await processImage(await photo(1000, 600, { orientation: 6 }), dir);
  assert.equal(m.width, 600, 'портретное после поворота');
  assert.equal(m.height, 1000);
  assert.deepEqual(m.widths, [400, 600]);
  const small = await processImage(await photo(350, 300), dir);
  assert.deepEqual(small.widths, [350]);
});

test('фото: не изображение и слишком маленькое', async () => {
  await assert.rejects(processImage(Buffer.from('not an image'), tmpdir()), /не похож на изображение/);
  await assert.rejects(processImage(await photo(200, 200), tmpdir()), /слишком маленькое/);
});
