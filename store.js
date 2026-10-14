// Фото и результаты разбора хранятся в IndexedDB на телефоне: если Safari перезагрузит
// страницу, список вернётся, а разбор продолжится с того же места.
const NAME = 'po-polochkam';
let opening = null;

function open() {
  if (!opening) {
    opening = new Promise((resolve) => {
      try {
        const request = indexedDB.open(NAME, 1);
        request.onupgradeneeded = () => {
          request.result.createObjectStore('photos', { keyPath: 'id' });
          request.result.createObjectStore('files');
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(null);
        request.onblocked = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }
  return opening;
}

async function transaction(stores, mode, work) {
  const db = await open();
  if (!db) return undefined;
  return new Promise((resolve) => {
    let result;
    try {
      const tx = db.transaction(stores, mode);
      tx.oncomplete = () => resolve(result);
      tx.onerror = tx.onabort = () => resolve(undefined);
      work(tx, (value) => { result = value; });
    } catch {
      resolve(undefined);
    }
  });
}

function all(store, method) {
  return new Promise((resolve) => {
    const request = store[method]();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve([]);
  });
}

export async function loadAll() {
  const loaded = await transaction(['photos', 'files'], 'readonly', (tx, done) => {
    Promise.all([
      all(tx.objectStore('photos'), 'getAll'),
      all(tx.objectStore('files'), 'getAllKeys'),
      all(tx.objectStore('files'), 'getAll'),
    ]).then(([records, keys, files]) => done({ records, files: new Map(keys.map((key, i) => [key, files[i]])) }));
  });
  return loaded || { records: [], files: new Map() };
}

export function saveFile(id, blob) {
  return transaction(['files'], 'readwrite', (tx) => tx.objectStore('files').put(blob, id));
}

export function savePhoto(record) {
  return transaction(['photos'], 'readwrite', (tx) => tx.objectStore('photos').put(record));
}

export function deletePhoto(id) {
  return transaction(['photos', 'files'], 'readwrite', (tx) => {
    tx.objectStore('photos').delete(id);
    tx.objectStore('files').delete(id);
  });
}

export function clearAll() {
  return transaction(['photos', 'files'], 'readwrite', (tx) => {
    tx.objectStore('photos').clear();
    tx.objectStore('files').clear();
  });
}
