// Скачивание больших моделей частями. Части хранятся в Cache Storage, поэтому после
// перезагрузки страницы модель берётся с телефона, а не качается заново.
export const MODEL_CACHE = 'po-polochkam-models';

async function openCache() {
  try {
    return await caches.open(MODEL_CACHE);
  } catch {
    return null;
  }
}

async function partBody(cache, url) {
  const hit = cache && await cache.match(url).catch(() => null);
  if (hit) return { body: hit.body, saved: Promise.resolve() };
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Не удалось скачать модель (${response.status})`);
  if (!cache) return { body: response.body, saved: Promise.resolve() };
  // Одну копию потока читаем сами, другую кладём в кеш
  const [mine, forCache] = response.body.tee();
  const saved = cache.put(url, new Response(forCache, { headers: { 'Content-Type': 'application/octet-stream' } })).catch(() => {});
  return { body: mine, saved };
}

// Возвращает модель одним буфером или, если asBlobs, списком Blob по частям
export async function download(urls, size, onProgress, { asBlobs = false } = {}) {
  const cache = await openCache();
  const bytes = asBlobs ? null : new Uint8Array(size);
  const blobs = [];
  let loaded = 0;
  for (const url of urls) {
    const { body, saved } = await partBody(cache, url);
    const reader = body.getReader();
    const chunks = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (bytes) {
        if (loaded + value.length > size) break;
        bytes.set(value, loaded);
      } else {
        chunks.push(value);
      }
      loaded += value.length;
      onProgress(loaded, size);
    }
    if (!bytes) blobs.push(new Blob(chunks));
    await saved;
  }
  if (loaded !== size) {
    if (cache) await Promise.all(urls.map((url) => cache.delete(url).catch(() => {})));
    throw new Error('Модель скачалась не полностью, обновите страницу');
  }
  return bytes || blobs;
}

// Убирает из кеша части прежних версий моделей
export async function pruneModelCache(keepUrls) {
  try {
    const cache = await caches.open(MODEL_CACHE);
    const keep = new Set(keepUrls);
    for (const request of await cache.keys()) {
      if (!keep.has(request.url)) await cache.delete(request);
    }
  } catch { /* кеш недоступен, например в приватном режиме */ }
}
