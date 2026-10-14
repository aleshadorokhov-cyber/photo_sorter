// Кодировщик изображений CLIP в отдельном потоке, чтобы страница не подвисала.
import * as ort from './vendor/ort/ort.wasm.min.mjs';

ort.env.wasm.wasmPaths = new URL('./vendor/ort/', import.meta.url).href;
ort.env.wasm.numThreads = 1;

let session = null;

async function download(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Не удалось скачать модель (${response.status})`);
  const total = Number(response.headers.get('content-length')) || 0;
  const reader = response.body.getReader();
  const chunks = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    postMessage({ type: 'progress', loaded, total });
  }
  const bytes = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}

onmessage = async ({ data }) => {
  try {
    if (data.type === 'load') {
      const bytes = await download(data.url);
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
