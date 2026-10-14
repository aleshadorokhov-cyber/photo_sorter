// Фоновый поток для темы текста (EmbeddingGemma). Модель отдаётся MediaPipe по адресу, а не буфером:
// так она занимает в памяти примерно в 2,5 раза меньше. Память уходит целиком, когда поток закрыт.
import { FilesetResolver, TextEmbedder } from './vendor/mediapipe/text_bundle.mjs';
import { download } from './models.js';

let embedder = null;

const handlers = {
  async load({ urls, size }) {
    const parts = await download(urls, size, (loaded, total) => postMessage({ type: 'progress', loaded, total }), { asBlobs: true });
    const url = URL.createObjectURL(new Blob(parts));
    try {
      // true: загрузчик в виде модуля, обычный в модульном потоке не работает
      const fileset = await FilesetResolver.forTextTasks(new URL('./vendor/mediapipe', import.meta.url).href, true);
      embedder = await TextEmbedder.createFromOptions(fileset, { baseOptions: { modelAssetPath: url } });
    } finally {
      URL.revokeObjectURL(url);
    }
    return {};
  },
  async embed({ text }) {
    return { vector: embedder.embed(text).embeddings[0].floatEmbedding };
  },
};

onmessage = async ({ data }) => {
  try {
    const result = await handlers[data.type](data);
    postMessage({ type: 'result', id: data.id, ...result });
  } catch (error) {
    postMessage({ type: 'error', id: data.id, message: String(error && error.message || error) });
  }
};
