// Работа с картинками. Одинаково работает в фоновом потоке (OffscreenCanvas) и на странице.

export async function decode(file) {
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch { /* старый Safari не знает этот параметр */ }
  try {
    return await createImageBitmap(file);
  } catch (error) {
    if (typeof Image === 'undefined') throw error;
  }
  // Запасной путь через <img> для форматов, которые createImageBitmap не берёт
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return await createImageBitmap(img);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function makeCanvas(width, height) {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

// Safari отдаёт память холста только при сборке мусора, поэтому освобождаем её сразу
export function release(c) {
  if (c && 'width' in c && !(c instanceof ImageBitmap)) {
    c.width = 0;
    c.height = 0;
  }
}

function toBlob(c, type, quality) {
  if (c.convertToBlob) return c.convertToBlob({ type, quality });
  return new Promise((resolve, reject) => c.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Не удалось сохранить картинку'))), type, quality));
}

// Уменьшает в несколько шагов, чтобы мелкие детали не превращались в шум
function scaled(source, sx, sy, sw, sh, width, height) {
  let current = source;
  let cx = sx, cy = sy, cw = sw, ch = sh;
  while (cw / 2 >= width * 1.5 && ch / 2 >= height * 1.5) {
    const step = makeCanvas(cw / 2, ch / 2);
    const ctx = step.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(current, cx, cy, cw, ch, 0, 0, step.width, step.height);
    if (current !== source) release(current);
    current = step; cx = 0; cy = 0; cw = step.width; ch = step.height;
  }
  const out = makeCanvas(width, height);
  const ctx = out.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(current, cx, cy, cw, ch, 0, 0, out.width, out.height);
  if (current !== source) release(current);
  return out;
}

function fit(bitmap, maxSide) {
  const s = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  return scaled(bitmap, 0, 0, bitmap.width, bitmap.height, bitmap.width * s, bitmap.height * s);
}

// Как в CLIP: квадрат по центру короткой стороны, 224x224, значения 0..1 по каналам
export function clipPixels(bitmap) {
  const side = Math.min(bitmap.width, bitmap.height);
  const c = scaled(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 224, 224);
  const { data } = c.getContext('2d').getImageData(0, 0, 224, 224);
  release(c);
  const plane = 224 * 224;
  const pixels = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    pixels[i] = data[i * 4] / 255;
    pixels[plane + i] = data[i * 4 + 1] / 255;
    pixels[2 * plane + i] = data[i * 4 + 2] / 255;
  }
  return pixels;
}

export async function thumbnail(bitmap) {
  const c = fit(bitmap, 360);
  try {
    return await toBlob(c, 'image/jpeg', 0.8);
  } finally {
    release(c);
  }
}

// Для чтения текста: не больше 2000 точек, мелкие снимки увеличиваются вдвое
export async function ocrImage(bitmap) {
  const longest = Math.max(bitmap.width, bitmap.height);
  const c = longest < 1200
    ? scaled(bitmap, 0, 0, bitmap.width, bitmap.height, bitmap.width * 2, bitmap.height * 2)
    : fit(bitmap, 2000);
  try {
    return await toBlob(c, 'image/png');
  } finally {
    release(c);
  }
}
