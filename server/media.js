// Обработка фото из админки: проверка, поворот по EXIF, удаление метаданных,
// копии 400/800/1600 px в WebP и JPEG. Исходник не хранится — только готовые копии.
import { randomBytes } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const WIDTHS = [400, 800, 1600];
const MIN_WIDTH = 300;
const FORMATS = new Set(['jpeg', 'png', 'webp', 'avif', 'tiff', 'gif']);

export class MediaError extends Error {
  status = 400;
}

/**
 * @returns {{ id, width, height, widths, bytes }} — размеры с учётом поворота
 */
export async function processImage(buffer, mediaDir) {
  let meta;
  try {
    meta = await sharp(buffer).metadata();
  } catch {
    throw new MediaError('Файл не похож на изображение');
  }
  if (meta.format === 'heif') {
    throw new MediaError('Формат HEIC не поддерживается — сохраните фото как JPEG (на iPhone: Настройки → Камера → Форматы → «Наиболее совместимый»)');
  }
  if (!FORMATS.has(meta.format)) throw new MediaError(`Формат ${meta.format} не поддерживается — нужен JPEG, PNG или WebP`);

  const rotated = (meta.orientation ?? 1) >= 5;
  const width = rotated ? meta.height : meta.width;
  const height = rotated ? meta.width : meta.height;
  if (width < MIN_WIDTH) throw new MediaError(`Фото слишком маленькое (${width} px по ширине), нужно от ${MIN_WIDTH} px`);

  // Стандартные ширины меньше исходной + сама исходная (не больше 1600): 1000 px → 400, 800, 1000.
  const widths = [...new Set([...WIDTHS.filter((w) => w < width), Math.min(width, WIDTHS.at(-1))])];

  const id = randomBytes(10).toString('hex');
  await mkdir(mediaDir, { recursive: true });
  const written = [];
  let bytes = 0;
  try {
    for (const w of widths) {
      const base = sharp(buffer, { limitInputPixels: 80e6 }).rotate().resize({ width: w, withoutEnlargement: true });
      for (const [ext, encode] of [['webp', (s) => s.webp({ quality: 80 })], ['jpg', (s) => s.jpeg({ quality: 82, mozjpeg: true })]]) {
        const file = path.join(mediaDir, `${id}-${w}.${ext}`);
        written.push(file);
        bytes += (await encode(base.clone()).toFile(file)).size;
      }
    }
  } catch (err) {
    await Promise.all(written.map((f) => rm(f, { force: true })));
    throw new MediaError(`Не удалось обработать фото: ${err.message}`);
  }
  return { id, width, height, widths, bytes };
}
