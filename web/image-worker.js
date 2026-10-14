// Фоновый поток для фото: открывает снимки, делает миниатюры и картинки для чтения текста,
// считает CLIP. Страница при этом не подвисает, а вся память потока уходит, когда он закрыт.
import * as ort from './vendor/ort/ort.wasm.min.mjs';
import { clipPixels, decode, ocrImage, thumbnail } from './images.js';
import { download } from './models.js';

ort.env.wasm.wasmPaths = new URL('./vendor/ort/', import.meta.url).href;
ort.env.wasm.numThreads = 1;

let session = null;

async function embed(pixels) {
  const output = await session.run({ image: new ort.Tensor('float32', pixels, [1, 3, 224, 224]) });
  return output.embedding.data;
}

// Ошибка открытия снимка: страница попробует открыть его сама
async function opened(file) {
  try {
    return await decode(file);
  } catch (error) {
    throw Object.assign(new Error(String(error && error.message || error)), { decode: true });
  }
}

const handlers = {
  async load({ urls, size }) {
    const bytes = await download(urls, size, (loaded, total) => postMessage({ type: 'progress', loaded, total }));
    session = await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'] });
    return {};
  },
  async analyze({ file }) {
    const bitmap = await opened(file);
    let thumb, pixels;
    try {
      thumb = await thumbnail(bitmap);
      pixels = clipPixels(bitmap);
    } catch (error) {
      throw Object.assign(error, { decode: true });
    } finally {
      bitmap.close();
    }
    return { thumb, vector: await embed(pixels) };
  },
  async embed({ pixels }) {
    return { vector: await embed(pixels) };
  },
  async ocrImage({ file }) {
    const bitmap = await opened(file);
    try {
      return { blob: await ocrImage(bitmap) };
    } catch (error) {
      throw Object.assign(error, { decode: true });
    } finally {
      bitmap.close();
    }
  },
};

onmessage = async ({ data }) => {
  try {
    const result = await handlers[data.type](data);
    postMessage({ type: 'result', id: data.id, ...result });
  } catch (error) {
    postMessage({ type: 'error', id: data.id, message: String(error && error.message || error), decode: Boolean(error && error.decode) });
  }
};
