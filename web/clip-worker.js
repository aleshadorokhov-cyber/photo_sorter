// Кодировщик изображений CLIP в отдельном потоке, чтобы страница не подвисала.
import * as ort from './vendor/ort/ort.wasm.min.mjs';

ort.env.wasm.wasmPaths = new URL('./vendor/ort/', import.meta.url).href;
ort.env.wasm.numThreads = 1;

let session = null;

// Модель лежит частями: склеиваем их в один буфер известного размера
async function download(urls, size) {
  const bytes = new Uint8Array(size);
  let loaded = 0;
  for (const url of urls) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Не удалось скачать модель (${response.status})`);
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes.set(value, loaded);
      loaded += value.length;
      postMessage({ type: 'progress', loaded, total: size });
    }
  }
  if (loaded !== size) throw new Error('Модель скачалась не полностью, обновите страницу');
  return bytes;
}

onmessage = async ({ data }) => {
  try {
    if (data.type === 'load') {
      const bytes = await download(data.urls, data.size);
      session = await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'] });
      postMessage({ type: 'loaded' });
    } else if (data.type === 'embed') {
      const input = new ort.Tensor('float32', data.pixels, [1, 3, 224, 224]);
      const output = await session.run({ image: input });
      postMessage({ type: 'embedding', id: data.id, vector: output.embedding.data });
    }
  } catch (error) {
    postMessage({ type: 'error', id: data.id, message: String(error && error.message || error) });
  }
};
