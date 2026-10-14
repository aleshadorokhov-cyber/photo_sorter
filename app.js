// По полочкам, веб-версия. Всё считается в браузере: фото никуда не отправляются.
import * as exifr from './vendor/exifr/lite.esm.mjs';
import Tesseract from './vendor/tesseract/tesseract.esm.min.js';
import { clipPixels, decode, ocrImage, thumbnail } from './images.js?v=e21da74b55';
import { pruneModelCache } from './models.js?v=e21da74b55';
import * as store from './store.js?v=e21da74b55';
import { crc32, zipBlob } from './zip.js?v=e21da74b55';

const BASE = new URL('./', import.meta.url);
const MODELS = new URL('./models/', BASE);

// Тот же префикс, с которым ml/export_topics.py кодировал темы
const TOPIC_PREFIX = 'task: classification | query: ';
// Категории, где почти всегда есть текст: в них текст читается сразу, в остальных по кнопке
const TEXT_CATEGORIES = new Set(['documents', 'study', 'notes', 'screenshots', 'receipts', 'shopping', 'memes', 'drawings']);
const TEXTY_CATEGORIES = ['documents', 'study', 'notes', 'screenshots', 'receipts'];
const WORD = /[A-Za-zА-Яа-яЁё]{3,}/g;

const state = {
  taxonomy: null,
  manifest: null,
  categories: null,
  labels: null,
  topics: null,
  cities: null,
  photos: [],
  busy: false,
  open: new Set(),
  nextId: 1,
};

const $ = (selector) => document.querySelector(selector);
// Для проверки из консоли браузера
globalThis.poPolochkam = state;

// ---------- Загрузка данных ----------

async function fetchOk(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Не удалось загрузить ${url.pathname || url} (${response.status})`);
  return response;
}

async function loadMatrix(name, rows) {
  const buffer = await (await fetchOk(new URL(name, MODELS))).arrayBuffer();
  const values = new Float32Array(buffer);
  return { values, rows, dim: values.length / rows };
}

function scores(matrix, vector) {
  const out = new Float32Array(matrix.rows);
  for (let r = 0; r < matrix.rows; r++) {
    let sum = 0;
    const base = r * matrix.dim;
    for (let d = 0; d < matrix.dim; d++) sum += matrix.values[base + d] * vector[d];
    out[r] = sum;
  }
  return out;
}

// Как в приложении: softmax от косинусной близости, умноженной на 100
function probabilities(matrix, vector) {
  const logits = scores(matrix, vector).map((s) => s * 100);
  const max = Math.max(...logits);
  const exps = logits.map((l) => Math.exp(l - max));
  const total = exps.reduce((a, b) => a + b, 0);
  return exps.map((e) => e / total);
}

function argmax(values) {
  let best = 0;
  for (let i = 1; i < values.length; i++) if (values[i] > values[best]) best = i;
  return best;
}

function normalize(vector) {
  let norm = 0;
  for (const v of vector) norm += v * v;
  norm = Math.sqrt(norm) || 1;
  return Float32Array.from(vector, (v) => v / norm);
}

function megabytes(bytes) {
  return Math.round(bytes / 1e6);
}

// ---------- Дата, место, скриншот ----------

function commentText(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  try { return new TextDecoder().decode(value); } catch { return ''; }
}

async function readMeta(file, type) {
  let tags = {};
  try {
    tags = (await exifr.parse(file, { tiff: true, exif: true, gps: true, xmp: false, icc: false, iptc: false, jfif: false, ihdr: false })) || {};
  } catch { /* у файла нет EXIF */ }
  const date = tags.DateTimeOriginal || tags.CreateDate || null;
  const comment = commentText(tags.UserComment);
  const isScreenshot = /screenshot/i.test(comment) || (type === 'image/png' && !tags.Make);
  const hasGps = Number.isFinite(tags.latitude) && Number.isFinite(tags.longitude) && !(tags.latitude === 0 && tags.longitude === 0);
  return {
    date: date instanceof Date && !isNaN(date) ? date : null,
    latitude: hasGps ? tags.latitude : null,
    longitude: hasGps ? tags.longitude : null,
    isScreenshot,
  };
}

// Город, в черте которого снято фото. Крупный город берёт верх над соседним посёлком
// (Пятигорск, а не Горячеводский), а за городом подписывается ближайший город не дальше 40 км.
async function placeName(latitude, longitude) {
  if (!state.cities) state.cities = await (await fetchOk(new URL('cities.json', MODELS))).json();
  const { names, coords, population = [] } = state.cities;
  const cos = Math.cos(latitude * Math.PI / 180);
  let nearest = -1, nearestKm = Infinity, inside = -1, insideScore = Infinity;
  for (let i = 0; i < names.length; i++) {
    const dy = coords[2 * i] - latitude;
    const dx = (coords[2 * i + 1] - longitude) * cos;
    const km = Math.sqrt(dy * dy + dx * dx) * 111.2;
    if (km < nearestKm) { nearestKm = km; nearest = i; }
    // Примерный радиус города: 5 км у Пятигорска, 22 км у Москвы, не меньше 3 км
    const people = population[i] || 5000;
    if (km <= Math.max(3, 0.1 * Math.cbrt(people))) {
      const score = km / people ** 0.4;
      if (score < insideScore) { insideScore = score; inside = i; }
    }
  }
  if (inside >= 0) return names[inside];
  return nearestKm <= 40 ? names[nearest] : null;
}

function isoDate(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// Имя вида «2026-07-23 Пятигорск, Белка», как в приложении
function proposedName(photo) {
  const parts = [];
  if (photo.date) parts.push(isoDate(photo.date));
  if (photo.place) parts.push(photo.place + ',');
  parts.push(photo.label);
  return parts.join(' ');
}

// Если модель не уверена, снимок идёт в «Прочее», а не в сомнительную категорию.
// Уверенность — доля лучшей категории в softmax; порог подобран на настоящих снимках
const OTHER = 'other';
const DOUBT = 0.6;

function autoCategory(photo) {
  return !photo.isScreenshot && photo.confidence < DOUBT ? OTHER : photo.category;
}

function categoryOf(photo) {
  return photo.userCategory || autoCategory(photo);
}

// Две самые вероятные категории: их видно у снимка из «Прочего», чтобы легче выбрать вручную
function guesses(photo) {
  const ids = state.taxonomy.categories.map((c) => c.id);
  return [...photo.probabilities].map((p, i) => [ids[i], p]).sort((a, b) => b[1] - a[1]).slice(0, 2);
}

// Значок у полки и у альбома, чтобы категорию было видно с одного взгляда
const ICONS = {
  nature: '🌿', sea: '🏖️', plants: '🌸', city: '🏙️', landmarks: '🏛️', art: '🎨', people: '👥', selfie: '🤳',
  animals: '🐾', food: '🍜', documents: '📄', study: '📚', notes: '✍️', screenshots: '📱', receipts: '🧾',
  shopping: '🛍️', tech: '💻', drawings: '📐', transport: '🚗', home: '🛋️', sport: '⚽', party: '🎉', memes: '😂',
  [OTHER]: '🧺',
};

function categoryIcon(id) {
  return ICONS[id] || '🗂️';
}

function categoryName(id) {
  if (id === OTHER) return 'Прочее';
  return state.taxonomy.categories.find((c) => c.id === id)?.name || id;
}

// ---------- Фоновые потоки ----------

// Обёртка над Worker: запрос — обещание с ответом. Закрытый поток отдаёт всю свою память.
class TaskWorker {
  constructor(script) {
    this.worker = new Worker(new URL(script, BASE), { type: 'module' });
    this.pending = new Map();
    this.counter = 0;
    this.worker.onmessage = ({ data }) => {
      if (data.type === 'progress') {
        this.onProgress?.(data.loaded, data.total);
        return;
      }
      const task = this.pending.get(data.id);
      this.pending.delete(data.id);
      if (data.type === 'error') task?.reject(Object.assign(new Error(data.message), { decode: data.decode }));
      else task?.resolve(data);
    };
    this.worker.onerror = (event) => {
      event.preventDefault?.();
      this.failAll(new Error(event.message || 'Фоновый поток не запустился'));
    };
  }

  request(message, transfer = []) {
    const id = ++this.counter;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ ...message, id }, transfer);
    });
  }

  load(model, onProgress) {
    this.onProgress = onProgress;
    const { parts, size } = state.manifest[model];
    return this.request({ type: 'load', urls: parts.map((p) => new URL(p, MODELS).href), size });
  }

  failAll(error) {
    for (const task of this.pending.values()) task.reject(error);
    this.pending.clear();
  }

  close() {
    this.worker.terminate();
    this.failAll(new Error('Поток закрыт'));
  }
}

async function createTextReader() {
  return Tesseract.createWorker(['rus', 'eng'], 1, {
    workerPath: new URL('vendor/tesseract/worker.min.js', BASE).href,
    corePath: new URL('vendor/tesseract-core/', BASE).href,
    langPath: new URL('vendor/tessdata', BASE).href,
    workerBlobURL: false,
    gzip: true,
  });
}

// ---------- Хранение на телефоне ----------

const SAVED_FIELDS = [
  'id', 'key', 'name', 'type', 'size', 'stage', 'error', 'thumbBlob',
  'date', 'latitude', 'longitude', 'place', 'isScreenshot',
  'category', 'userCategory', 'confidence', 'probabilities', 'label', 'labelConfidence',
  'lines', 'textSkipped', 'forceText', 'topic', 'topicError', 'crc',
];

function isListed(photo) {
  return state.photos.includes(photo);
}

function persist(photo) {
  if (!isListed(photo)) return Promise.resolve();
  const record = {};
  for (const key of SAVED_FIELDS) if (photo[key] !== undefined) record[key] = photo[key];
  return store.savePhoto(record);
}

function setThumb(photo, blob) {
  if (photo.thumb) URL.revokeObjectURL(photo.thumb);
  photo.thumbBlob = blob;
  photo.thumb = blob ? URL.createObjectURL(blob) : null;
}

async function restore() {
  const { records, files } = await store.loadAll();
  for (const record of records.sort((a, b) => a.id - b.id)) {
    const file = files.get(record.id);
    if (!file) {
      store.deletePhoto(record.id);
      continue;
    }
    const photo = { lines: [], ...record, file };
    if (photo.thumbBlob) photo.thumb = URL.createObjectURL(photo.thumbBlob);
    state.photos.push(photo);
  }
  state.nextId = state.photos.reduce((max, p) => Math.max(max, p.id), 0) + 1;
}

// ---------- Разбор ----------

function setStatus(text, fraction = null) {
  $('#status').hidden = !text;
  $('#status-text').textContent = text || '';
  const bar = $('#status-bar');
  bar.hidden = fraction == null;
  if (fraction != null) bar.value = fraction;
}

function readText(data) {
  const words = [];
  const lines = [];
  for (const block of data.blocks || []) {
    for (const paragraph of block.paragraphs || []) {
      for (const line of paragraph.lines || []) {
        const kept = [];
        for (const word of line.words || []) {
          const text = word.text.trim();
          if (word.confidence >= 70 && /^[A-Za-zА-Яа-яЁё][A-Za-zА-Яа-яЁё'\-]{2,}$/.test(text.replace(/^[.,:;!?()«»"]+|[.,:;!?()«»"]+$/g, ''))) words.push(text);
          if (text && word.confidence >= 60) kept.push(text);
        }
        const joined = kept.join(' ').replace(/^[\s|=_~—-]+|[\s|=_~—-]+$/g, '');
        if ((joined.match(WORD) || []).length >= 2) lines.push(joined);
      }
    }
  }
  return words.length >= 3 ? lines : [];
}

function needsText(photo) {
  if (photo.forceText) return true;
  if (TEXT_CATEGORIES.has(categoryOf(photo))) return true;
  const ids = state.taxonomy.categories.map((c) => c.id);
  const texty = TEXTY_CATEGORIES.reduce((sum, id) => sum + (photo.probabilities[ids.indexOf(id)] || 0), 0);
  return texty >= 0.15;
}

const WAIT_HINT = 'Не уходите со страницы: в фоне iPhone ставит разбор на паузу. Если страница перезагрузится, разбор продолжится.';

// Даёт странице ответить на нажатия между тяжёлыми шагами
const breathe = () => new Promise((resolve) => setTimeout(resolve, 0));

// Снимок открывает фоновый поток, а если не смог, то сама страница
async function analyzePhoto(worker, photo) {
  Object.assign(photo, await readMeta(photo.file, photo.type));
  let result;
  try {
    result = await worker.request({ type: 'analyze', file: photo.file });
  } catch (error) {
    if (!error.decode) throw error;
    const bitmap = await decode(photo.file);
    try {
      const thumb = await thumbnail(bitmap);
      const pixels = clipPixels(bitmap);
      result = { ...(await worker.request({ type: 'embed', pixels }, [pixels.buffer])), thumb };
    } finally {
      bitmap.close?.();
    }
  }
  setThumb(photo, result.thumb);
  const vector = normalize(result.vector);
  photo.probabilities = probabilities(state.categories, vector);
  const c = argmax(photo.probabilities);
  photo.category = photo.isScreenshot ? 'screenshots' : state.taxonomy.categories[c].id;
  photo.confidence = photo.isScreenshot ? 1 : photo.probabilities[c];
  const labels = probabilities(state.labels, vector);
  const l = argmax(labels);
  photo.label = state.taxonomy.labels[l].ru;
  photo.labelConfidence = labels[l];
  photo.place = null;
  if (photo.latitude != null) {
    try { photo.place = await placeName(photo.latitude, photo.longitude); } catch { photo.place = null; }
  }
}

async function analyzeImages() {
  const todo = state.photos.filter((p) => p.stage === 'new');
  if (!todo.length) return;
  const worker = new TaskWorker('./image-worker.js?v=e21da74b55');
  try {
    await worker.load('image', (loaded, total) => setStatus(
      `Загружаю модель для фото: ${megabytes(loaded)} из ${megabytes(total)} МБ. Это нужно один раз.`, loaded / total));
    let done = 0;
    for (const photo of todo) {
      if (!isListed(photo)) continue;
      setStatus(`Смотрю, что на фото: ${done + 1} из ${todo.length}. ${WAIT_HINT}`, done / todo.length);
      try {
        await analyzePhoto(worker, photo);
        photo.stage = 'image';
      } catch (error) {
        console.error(error);
        photo.stage = 'failed';
        photo.error = String(error.message || error);
      }
      await persist(photo);
      done++;
      scheduleRender();
      await breathe();
    }
  } finally {
    worker.close();
  }
}

async function analyzeText() {
  for (const photo of state.photos) {
    if (photo.stage === 'image' && !needsText(photo)) {
      photo.stage = 'done';
      photo.textSkipped = true;
      persist(photo);
    }
  }
  const todo = state.photos.filter((p) => p.stage === 'image');
  if (!todo.length) return;
  setStatus('Загружаю распознавание текста…');
  // Поток только готовит картинки для чтения текста, модель CLIP он не загружает
  const worker = new TaskWorker('./image-worker.js?v=e21da74b55');
  const reader = await createTextReader();
  try {
    let done = 0;
    for (const photo of todo) {
      if (!isListed(photo)) continue;
      setStatus(`Читаю текст: ${done + 1} из ${todo.length}. ${WAIT_HINT}`, done / todo.length);
      try {
        let image;
        try {
          image = (await worker.request({ type: 'ocrImage', file: photo.file })).blob;
        } catch (error) {
          if (!error.decode) throw error;
          const bitmap = await decode(photo.file);
          try { image = await ocrImage(bitmap); } finally { bitmap.close?.(); }
        }
        const { data } = await reader.recognize(image, {}, { blocks: true, text: true });
        photo.lines = readText(data);
        photo.textSkipped = false;
        photo.stage = photo.lines.length ? 'text' : 'done';
      } catch (error) {
        console.error(error);
        photo.stage = 'done';
      }
      await persist(photo);
      done++;
      scheduleRender();
      await breathe();
    }
  } finally {
    worker.close();
    await reader.terminate();
  }
}

async function analyzeTopics() {
  const todo = state.photos.filter((p) => p.stage === 'text');
  if (!todo.length) return;
  if (!state.topics) state.topics = await loadMatrix('topics.f32', state.taxonomy.topics.length);
  const worker = new TaskWorker('./topic-worker.js?v=e21da74b55');
  try {
    try {
      await worker.load('topic', (loaded, total) => setStatus(
        `Загружаю модель для темы текста: ${megabytes(loaded)} из ${megabytes(total)} МБ. Это нужно один раз.`, loaded / total));
    } catch (error) {
      console.error(error);
      for (const photo of todo) {
        photo.stage = 'done';
        photo.topicError = true;
        await persist(photo);
      }
      return;
    }
    let done = 0;
    for (const photo of todo) {
      if (!isListed(photo)) continue;
      setStatus(`Определяю тему текста: ${done + 1} из ${todo.length}. ${WAIT_HINT}`, done / todo.length);
      try {
        const text = photo.lines.join(' ').slice(0, 600);
        const { vector } = await worker.request({ type: 'embed', text: TOPIC_PREFIX + text });
        photo.topic = state.taxonomy.topics[argmax(scores(state.topics, normalize(vector)))];
      } catch (error) {
        console.error(error);
        photo.topicError = true;
      }
      photo.stage = 'done';
      await persist(photo);
      done++;
      scheduleRender();
    }
  } finally {
    worker.close();
  }
}

// Пока идёт разбор, экран не гаснет (Safari 16.4 и новее)
let wakeLock = null;
async function keepAwake(on) {
  try {
    if (on && !wakeLock && document.visibilityState === 'visible' && navigator.wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } else if (!on && wakeLock) {
      const lock = wakeLock;
      wakeLock = null;
      await lock.release();
    }
  } catch {
    wakeLock = null;
  }
}

const unfinished = (p) => p.stage === 'new' || p.stage === 'image' || p.stage === 'text';

async function run() {
  if (state.busy) return;
  state.busy = true;
  keepAwake(true);
  render();
  try {
    while (state.photos.some(unfinished)) {
      await analyzeImages();
      await analyzeText();
      await analyzeTopics();
    }
    setStatus('');
  } catch (error) {
    console.error(error);
    setStatus(`Ошибка: ${error.message || error}. Обновите страницу, разбор продолжится с того же места.`);
  } finally {
    state.busy = false;
    keepAwake(false);
    render();
  }
}

function isImage(file) {
  return file.type.startsWith('image/') || /\.(heic|heif|jpe?g|png|webp)$/i.test(file.name);
}

let noteTimer = null;
function note(text) {
  if (state.busy) return;
  setStatus(text);
  clearTimeout(noteTimer);
  noteTimer = setTimeout(() => { if (!state.busy && $('#status-text').textContent === text) setStatus(''); }, 6000);
}

async function addFiles(files) {
  const known = new Set(state.photos.map((p) => p.key));
  const added = [];
  let repeated = 0;
  for (const file of files) {
    if (!isImage(file)) continue;
    const key = `${file.name}|${file.size}`;
    if (known.has(key)) {
      repeated++;
      continue;
    }
    known.add(key);
    const photo = { id: state.nextId++, key, file, name: file.name, type: file.type, size: file.size, stage: 'new', lines: [] };
    state.photos.push(photo);
    added.push(photo);
  }
  if (!added.length) {
    if (repeated) note('Эти фото уже есть в списке.');
    return;
  }
  setStatus(`Добавляю ${added.length} фото…`);
  render();
  run();
  // Копии фото на телефоне, чтобы список пережил перезагрузку страницы
  for (const photo of added) {
    if (!isListed(photo)) continue;
    await store.saveFile(photo.id, photo.file);
    await persist(photo);
  }
}

async function clearAll() {
  if (!state.photos.length) return;
  if (!confirm('Убрать все фото из списка? В галерее iPhone они останутся.')) return;
  for (const photo of state.photos) if (photo.thumb) URL.revokeObjectURL(photo.thumb);
  state.photos = [];
  state.open.clear();
  await store.clearAll();
  setStatus(state.busy ? 'Останавливаю разбор…' : '');
  render();
}

// ---------- Сохранение ----------

function extension(photo) {
  const match = /\.([a-z0-9]+)$/i.exec(photo.name || '');
  if (match) return match[1].toLowerCase() === 'jpeg' ? 'jpg' : match[1].toLowerCase();
  return { 'image/png': 'png', 'image/heic': 'heic', 'image/webp': 'webp' }[photo.type] || 'jpg';
}

function safe(name) {
  return name.replace(/[\/\\:*?"<>|]/g, '-').trim() || 'Фото';
}

let saving = false;
async function saveZip(list, zipName) {
  if (saving) return;
  saving = true;
  const total = list.reduce((sum, g) => sum + g.photos.length, 0);
  try {
    const entries = [];
    for (const group of list) {
      const used = new Set();
      const folder = safe(categoryName(group.id));
      for (const photo of group.photos) {
        setStatus('Собираю архив…', entries.length / total);
        const ext = extension(photo);
        const base = safe(proposedName(photo));
        let name = `${base}.${ext}`;
        for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base} (${n}).${ext}`;
        used.add(name.toLowerCase());
        if (photo.crc == null) {
          photo.crc = await crc32(photo.file);
          persist(photo);
        }
        entries.push({ name: `${folder}/${name}`, blob: photo.file, crc: photo.crc, date: photo.date || new Date() });
      }
    }
    const url = URL.createObjectURL(zipBlob(entries));
    const link = document.createElement('a');
    link.href = url;
    link.download = zipName;
    document.body.appendChild(link);
    link.click();
    setTimeout(() => { link.remove(); URL.revokeObjectURL(url); }, 120000);
    note('Архив готов. Если Safari спросит, нажмите «Загрузить»: архив появится в «Файлах», в папке «Загрузки».');
  } catch (error) {
    console.error(error);
    setStatus(`Не удалось собрать архив: ${error.message || error}`);
  } finally {
    saving = false;
  }
}

// ---------- Альбомы в «Фото» через «Команды» ----------

const SHORTCUT_NAME = 'По полочкам';
const NAME_KEY = 'shortcut-name';

// Ссылки iCloud на готовые команды («Поделиться» → «Скопировать ссылку iCloud»).
// Пока ссылки пустые, на странице остаются только шаги ручной сборки
const SHORTCUT_LINKS = {
  one: '',
  main: '',
  add: '',
  remove: '',
};

function setupInstall() {
  for (const [key, url] of Object.entries(SHORTCUT_LINKS)) {
    const link = $(`#install-${key}`);
    link.hidden = !url;
    if (url) link.href = url;
  }
  if (!Object.values(SHORTCUT_LINKS).some(Boolean)) return;
  $('#install').hidden = false;
  // Кто ставит готовые команды, получает и «Разложить по полочкам», так что сразу одна кнопка
  $('#install-one').addEventListener('click', () => setOneMode(true));
  $('#shortcut-help summary').textContent = 'Если установка не сработала: собрать команды вручную';
}

// Имя команды можно поменять на странице, если на iPhone её назвали иначе
function shortcutName() {
  return $('#shortcut-name').value.trim() || SHORTCUT_NAME;
}

function setupShortcutName() {
  const input = $('#shortcut-name');
  try {
    const saved = localStorage.getItem(NAME_KEY);
    if (saved) input.value = saved;
  } catch { /* без хранилища остаётся имя по умолчанию */ }
  input.addEventListener('change', () => {
    try {
      const name = input.value.trim();
      if (name && name !== SHORTCUT_NAME) localStorage.setItem(NAME_KEY, name);
      else localStorage.removeItem(NAME_KEY);
    } catch { /* не сохранилось, но на этот раз имя всё равно возьмётся из поля */ }
  });
}

// Имя снимка в «Фото», как его видит действие «Найти фото»: имя файла без расширения
function libraryName(photo) {
  const base = (photo.name || '').replace(/\.[^.]+$/, '');
  if (!base || /^(FullSizeRender|image|photo)$/i.test(base)) return null;
  // Снимки iPhone называются IMG_1234. Отредактированная копия приходит как IMG_E1234,
  // а при переводе HEIC в JPEG браузер может дописать хвост вроде IMG_1234_ab12cd:
  // в галерее это всё тот же IMG_1234
  const camera = base.match(/^IMG_E?(\d{4})(?!\d)/i);
  return camera ? `IMG_${camera[1]}` : base;
}

function albumPlan() {
  const plan = {};
  const icons = {};
  let photos = 0, skipped = 0;
  for (const group of groups()) {
    const names = [...new Set(group.photos.map(libraryName).filter(Boolean))];
    skipped += group.photos.length - group.photos.filter(libraryName).length;
    if (!names.length) continue;
    plan[`Сортировка: ${categoryName(group.id)}`] = names;
    icons[`Сортировка: ${categoryName(group.id)}`] = categoryIcon(group.id);
    photos += names.length;
  }
  const examples = Object.values(plan).flat().slice(0, 3);
  return { plan, icons, albums: Object.keys(plan).length, photos, skipped, examples };
}

// Вторая команда: та же, но не создаёт альбом, а докладывает снимки в уже существующий.
// Третья убирает снимки из альбома, откуда их брали; из медиатеки они не удаляются
function addShortcutName() {
  return `${shortcutName()} добавить`;
}

function removeShortcutName() {
  return `${shortcutName()} убрать`;
}

// Убирать ли снимки из альбома, откуда их брали. Сайт этого альбома не знает: его спросит
// сама третья команда списком альбомов (Ask Each Time), поэтому ключ в раскладке только подпись
const REMOVE_KEY = 'remove-source';
const SOURCE_LABEL = 'Альбом, откуда брали снимки';

function removeEnabled() {
  return $('#remove-source').checked;
}

function setupRemoveSource() {
  const box = $('#remove-source');
  try {
    box.checked = localStorage.getItem(REMOVE_KEY) === '1';
  } catch { /* без хранилища галочка просто не запомнится */ }
  box.addEventListener('change', () => {
    try {
      if (box.checked) localStorage.setItem(REMOVE_KEY, '1');
      else localStorage.removeItem(REMOVE_KEY);
    } catch { /* не запомнилось, но на этот раз сработает */ }
    resetSteps();
  });
}

// Одна кнопка: команда «Разложить по полочкам» сама по очереди зовёт три команды выше,
// каждой кладя в буфер её часть раскладки. Пока её не проверили, кнопка запускает три команды
// по одной, как раньше, чтобы у тех, кто её ещё не собрал, ничего не сломалось
const ONE_NAME = 'Разложить по полочкам';
const ONE_KEY = 'one-shortcut';
const ONE_TEST_ALBUM = 'Проверка одной кнопки';
let one = false;

function oneMode() {
  return one;
}

function setOneMode(on) {
  one = on;
  try {
    if (on) localStorage.setItem(ONE_KEY, '1');
    else localStorage.removeItem(ONE_KEY);
  } catch { /* не запомнилось: в следующий раз включите заново */ }
  applyMode();
  resetSteps();
}

function applyMode() {
  $('#use-one').hidden = one;
  $('#use-three').hidden = !one;
  $('#one-intro').hidden = one;
  setText($('#one-summary'), one ? `Команда «${ONE_NAME}»` : 'Одна кнопка вместо трёх');
}

function setupMode() {
  try {
    one = localStorage.getItem(ONE_KEY) === '1';
  } catch { /* без хранилища остаются три команды по очереди */ }
  $('#use-one').addEventListener('click', () => {
    setOneMode(true);
    $('#one-setup').open = false;
    showNote('Готово: теперь кнопка «Разложить по альбомам» делает всё за один запуск.');
  });
  $('#use-three').addEventListener('click', () => setOneMode(false));
  applyMode();
}

// Раздел раскладки лежит строкой: ровно то, что раньше уходило в буфер для своей команды.
// «Разложить по полочкам» копирует его в буфер как есть, и команда читает его как обычно
function onePayload(steps, plan) {
  const part = (kind) => {
    const step = steps.find((s) => s.kind === kind);
    return JSON.stringify((step && stepPayload(step, plan)) || {});
  };
  return { убрать: part('remove'), создать: part('create'), добавить: part('add') };
}

// Альбомы, которые уже есть в «Фото». Названия берутся из постоянного списка категорий,
// поэтому при следующей сортировке они совпадут, и снимки лягут в те же альбомы
const MADE_KEY = 'albums-made';

function madeAlbums() {
  try {
    return new Set(JSON.parse(localStorage.getItem(MADE_KEY)) || []);
  } catch {
    return new Set();
  }
}

function saveMadeAlbums(made) {
  try {
    localStorage.setItem(MADE_KEY, JSON.stringify([...made]));
  } catch { /* не запомнилось: в следующий раз галочки придётся поставить заново */ }
}

// Шаги раскладки, по одному на нажатие: убрать снимки из альбома, откуда их брали,
// создать новые альбомы, доложить в старые. Каждый шаг запускает свою команду.
// «Убрать» идёт первым: если по ошибке выбрать альбом «Сортировка: …», следующие шаги вернут снимки на место
let pending = [];

function planSteps(plan) {
  const made = madeAlbums();
  const albums = Object.keys(plan);
  const steps = [];
  if (removeEnabled()) steps.push({ kind: 'remove' });
  const fresh = albums.filter((album) => !made.has(album));
  const existing = albums.filter((album) => made.has(album));
  if (fresh.length) steps.push({ kind: 'create', albums: new Set(fresh) });
  if (existing.length) steps.push({ kind: 'add', albums: new Set(existing) });
  return steps;
}

// Что положить в буфер для шага. Для «убрать» это та же раскладка, но все снимки под одной подписью
function stepPayload(step, plan) {
  if (step.kind === 'remove') {
    const names = [...new Set(Object.values(plan).flat())];
    return names.length ? { [SOURCE_LABEL]: names } : null;
  }
  const part = pick(plan, step.albums);
  return Object.keys(part).length ? part : null;
}

function stepButton(step) {
  if (oneMode()) return removeEnabled() ? 'Убрать из старого альбома и разложить' : 'Разложить по альбомам';
  if (step?.kind === 'add') return 'Доложить в альбомы, которые уже есть';
  if (step?.kind === 'create') return 'Разложить по альбомам';
  if (step?.kind === 'remove') return 'Убрать снимки из старого альбома';
  return removeEnabled() ? 'Убрать из старого альбома и разложить' : 'Разложить по альбомам';
}

function resetSteps() {
  pending = [];
  renderAlbums();
}

// Подсказка над нижней кнопкой: её видно и после возвращения из Shortcuts, пока не закроют
function showNote(text) {
  setText($('#albums-note'), text);
  $('#toast').hidden = !text;
}

// Кладёт раскладку в буфер обмена и запускает команду. help: какие шаги раскрыть к возвращению
async function runShortcut(plan, name, message, help = null) {
  try {
    await navigator.clipboard.writeText(JSON.stringify(plan));
  } catch {
    showNote('Safari не дал скопировать список. Нажмите кнопку ещё раз.');
    return false;
  }
  showNote(`${message} Открываю команду «${name}». Если Shortcuts пишут, что её нет (Could not find the shortcut),`
    + ' сначала соберите её по шагам в «Помощи и настройке».');
  // Шаги остаются открытыми, когда вы вернётесь из Shortcuts
  if (help) {
    help.open = true;
    help.closest('.panel').open = true;
  }
  location.href = `shortcuts://run-shortcut?name=${encodeURIComponent(name)}`;
  return true;
}

function pick(plan, albums) {
  return Object.fromEntries(Object.entries(plan).filter(([album]) => albums.has(album)));
}

function sizeOf(plan) {
  return { albums: Object.keys(plan).length, photos: Object.values(plan).flat().length };
}

async function toAlbums() {
  const { plan, albums, skipped, examples } = albumPlan();
  if (!albums) {
    showNote('Ни один снимок не найти по имени файла.');
    return;
  }
  if (oneMode()) {
    await toAlbumsOnce(plan, skipped);
    return;
  }
  if (!pending.length) pending = planSteps(plan);
  while (pending.length && !stepPayload(pending[0], plan)) pending.shift();
  const step = pending[0];
  if (!step) {
    renderAlbums();
    return;
  }
  const payload = stepPayload(step, plan);
  const size = sizeOf(payload);
  const next = pending[1]
    ? ` Когда вернётесь, нажмите кнопку ещё раз: «${stepButton(pending[1])}».` : '';
  let ok;
  if (step.kind === 'create') {
    const lost = skipped ? ` Без имени файла и не попадут в альбомы: ${skipped}.` : '';
    ok = await runShortcut(payload, shortcutName(),
      `Создаю новые альбомы: ${size.albums}, фото ${size.photos}, ищу по именам вроде ${examples.join(', ')}.${lost}${next}`);
    if (ok) {
      const made = madeAlbums();
      for (const album of Object.keys(payload)) made.add(album);
      saveMadeAlbums(made);
    }
  } else if (step.kind === 'add') {
    ok = await runShortcut(payload, addShortcutName(),
      `Докладываю в альбомы, которые уже есть: альбомов ${size.albums}, фото ${size.photos}.${next}`);
  } else {
    ok = await runShortcut(payload, removeShortcutName(),
      `Убираю снимки из альбома, откуда их брали: ${size.photos}. iPhone спросит, из какого альбома: нажмите его в списке.`
      + ` Из «Фото» снимки не удаляются.${next}`);
  }
  if (ok) pending.shift();
  renderAlbums();
}

// Всё за один запуск «Разложить по полочкам»
async function toAlbumsOnce(plan, skipped) {
  const steps = planSteps(plan);
  const fresh = steps.find((step) => step.kind === 'create')?.albums ?? new Set();
  const { albums, photos } = sizeOf(plan);
  const lost = skipped ? ` Без имени файла и не попадут в альбомы: ${skipped}.` : '';
  const ask = removeEnabled()
    ? ' Сначала iPhone спросит, из какого альбома убрать снимки: нажмите его в списке. Из «Фото» они не удаляются.' : '';
  const ok = await runShortcut(onePayload(steps, plan), ONE_NAME,
    `Раскладываю ${photos} фото по альбомам: ${albums}` + (fresh.size ? `, из них новых ${fresh.size}.` : '.') + ask + lost);
  if (ok && fresh.size) {
    const made = madeAlbums();
    for (const album of fresh) made.add(album);
    saveMadeAlbums(made);
  }
  renderAlbums();
}

// Проверка одной кнопки: первый снимок создаёт альбом, второй докладывается в него в том же запуске
async function testOne() {
  const { examples } = albumPlan();
  if (!examples.length) {
    showNote('Ни один снимок не найти по имени файла.');
    return;
  }
  const [first, second = first] = examples;
  const payload = {
    убрать: '{}',
    создать: JSON.stringify({ [ONE_TEST_ALBUM]: [first] }),
    добавить: JSON.stringify({ [ONE_TEST_ALBUM]: [second] }),
  };
  await runShortcut(payload, ONE_NAME,
    `Проверка: в «Фото» должен появиться альбом «${ONE_TEST_ALBUM}»`
    + (second === first ? ` со снимком ${first}.` : ` с двумя снимками, ${first} и ${second}.`)
    + ' Если снимок в нём один, в шаге 9 у Get Value последним словом должно стоять Dictionary, а не Shortcut Result.'
    + ' Если альбома нет совсем, проверьте то же в шаге 7, а если там верно, пришлите в чат снимок экрана команды. Проверочный альбом потом удалите.',
    $('#one-setup'));
}

const TEST_ALBUM = 'Проверка По полочкам';

// Один альбом с одним снимком: по нему видно, правильно ли собрана команда
async function testShortcut() {
  const { examples } = albumPlan();
  if (!examples.length) {
    showNote('Ни один снимок не найти по имени файла.');
    return;
  }
  const photo = examples[0];
  await runShortcut({ [TEST_ALBUM]: [photo] }, shortcutName(),
    `Проверка: в «Фото» должен появиться альбом «${TEST_ALBUM}» с одним снимком ${photo}.`
    + ' Если альбом назван длинной строкой со скобками, в команде не хватает действия «Get All Keys in Dictionary» (как добавить, написано в начале шагов ниже) или в Create Photo Album выбрано не Repeat Item.'
    + ' Если альбом пустой, проверьте значки: в «Get Value for Repeat Item in Dictionary» и в «Find Photos where Name begins with Repeat Item 2» у Repeat Item должны быть серые стрелки. Без значка это напечатанные буквы: сотрите их и выберите переменную.'
    + ' Если в альбоме белая картинка с именем снимка, действие читается «Filter … where» вместо «Find Photos where»: нажмите плашку Repeat Item 2 после Filter и выберите Clear, а картинку удалите.'
    + ' Проверочный альбом потом удалите.', $('#shortcut-help'));
}

// Второй снимок в тот же проверочный альбом: так видно, что вторая команда докладывает, а не копирует
async function testAddShortcut() {
  const { examples } = albumPlan();
  if (!examples.length) {
    showNote('Ни один снимок не найти по имени файла.');
    return;
  }
  const [first, second = first] = examples;
  await runShortcut({ [TEST_ALBUM]: [second] }, addShortcutName(),
    `Проверка добавления. Альбом «${TEST_ALBUM}» уже должен быть после обычной проверки, со снимком ${first}.`
    + (second === first ? ' Снимок добавится тот же, в альбоме останется один.' : ` Теперь в нём должно стать два снимка: ${first} и ${second}.`)
    + ' В «Недавних» не должно появиться новых снимков с сегодняшней датой. Если появилась копия, удалите её и напишите в чат.'
    + ' Если альбом пустой или Shortcuts пишут, что не нашли альбом, пришлите снимок экрана команды. Проверочный альбом потом удалите.',
    $('#shortcut-help'));
}

// Третья команда на том же проверочном альбоме: первый снимок уходит из альбома, но остаётся в «Фото»
async function testRemoveShortcut() {
  const { examples } = albumPlan();
  if (!examples.length) {
    showNote('Ни один снимок не найти по имени файла.');
    return;
  }
  const [first] = examples;
  await runShortcut({ [SOURCE_LABEL]: [first] }, removeShortcutName(),
    `Проверка третьей команды. iPhone спросит альбом: выберите «${TEST_ALBUM}».`
    + ` Из него должен пропасть снимок ${first}, а сам снимок должен остаться в Recents.`
    + ' Альбом «Проверка По полочкам» появляется после двух проверок выше. Проверочный альбом потом удалите.',
    $('#shortcut-help'));
}

// Один переключатель на все альбомы сразу
function setupAllMade() {
  $('#all-made').addEventListener('change', (event) => {
    const { plan } = albumPlan();
    const made = madeAlbums();
    for (const album of Object.keys(plan)) {
      if (event.target.checked) made.add(album);
      else made.delete(album);
    }
    saveMadeAlbums(made);
    resetSteps();
  });
}

// Свёрнутые и раскрытые разделы запоминаются
const PANELS_KEY = 'panels';

function setupPanels() {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(PANELS_KEY)) || {};
  } catch { /* без хранилища разделы открываются как по умолчанию */ }
  for (const panel of document.querySelectorAll('details.panel')) {
    if (panel.id in saved) panel.open = saved[panel.id];
    panel.addEventListener('toggle', () => {
      saved[panel.id] = panel.open;
      try {
        localStorage.setItem(PANELS_KEY, JSON.stringify(saved));
      } catch { /* не запомнилось: в следующий раз раздел откроется как по умолчанию */ }
    });
  }
}

// Галочки «альбом уже есть»: по ним кнопка решает, создать альбом или доложить в него
let albumsKey = '';

function renderAlbums() {
  const { plan, icons } = albumPlan();
  const made = madeAlbums();
  const albums = Object.keys(plan);
  const all = $('#all-made');
  const done = albums.filter((album) => made.has(album)).length;
  all.checked = albums.length > 0 && done === albums.length;
  all.indeterminate = done > 0 && done < albums.length;
  setText($('#albums-meta'), albums.length ? `альбомов: ${albums.length}` : '');
  const key = JSON.stringify(albums.map((a) => [a, plan[a].length, made.has(a)]));
  setText($('#to-albums'), stepButton(pending[0]));
  if (key === albumsKey) return;
  albumsKey = key;
  $('#album-head').hidden = !albums.length;
  $('#album-list').replaceChildren(...albums.map((album) => {
    const box = el('input', { type: 'checkbox', className: 'switch', checked: made.has(album), ariaLabel: `${album}: уже есть в «Фото»` });
    box.addEventListener('change', () => {
      const current = madeAlbums();
      if (box.checked) current.add(album);
      else current.delete(album);
      saveMadeAlbums(current);
      resetSteps();
    });
    return el('label', { className: 'album-row' }, [
      el('span', { className: 'album-name' }, `${icons[album]} ${album.replace(/^Сортировка: /, '')}`),
      el('span', { className: 'count' }, String(plan[album].length)),
      box,
    ]);
  }));
}

// ---------- Экран ----------

function groups() {
  const map = new Map();
  for (const photo of state.photos) {
    if (!photo.category) continue;
    const id = categoryOf(photo);
    if (!map.has(id)) map.set(id, []);
    map.get(id).push(photo);
  }
  const list = [...map.entries()].map(([id, photos]) => ({
    id,
    // Внутри категории от новых к старым, фото без даты в конце
    photos: photos.sort((a, b) => (b.date?.getTime() ?? -Infinity) - (a.date?.getTime() ?? -Infinity)),
  }));
  // «Прочее» всегда в конце
  return list.sort((a, b) => (a.id === OTHER) - (b.id === OTHER) || b.photos.length - a.photos.length
    || categoryName(a.id).localeCompare(categoryName(b.id), 'ru'));
}

let renderTimer = null;
function scheduleRender() {
  if (renderTimer) return;
  renderTimer = setTimeout(() => { renderTimer = null; render(); }, 400);
}

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (value != null) node[key] = value;
  }
  for (const child of [].concat(children)) if (child != null) node.append(child);
  return node;
}

function setText(node, text) {
  if (node.textContent !== text) node.textContent = text;
}

// Экран обновляется по месту: уже показанные группы и миниатюры не пересоздаются,
// поэтому нажатия не теряются, пока идёт разбор
const view = { groups: new Map(), cells: new Map() };

function cellFor(photo) {
  let cell = view.cells.get(photo.id);
  if (!cell) {
    cell = el('button', { class: 'cell', onclick: () => openPhoto(photo) }, [el('img', { alt: '', loading: 'lazy' })]);
    view.cells.set(photo.id, cell);
  }
  const img = cell.firstChild;
  if (photo.thumb && img.getAttribute('src') !== photo.thumb) img.src = photo.thumb;
  const name = proposedName(photo);
  if (cell.title !== name) {
    cell.title = name;
    img.alt = name;
  }
  return cell;
}

function groupView(id) {
  const existing = view.groups.get(id);
  if (existing) return existing;
  const details = el('details', { class: 'group' });
  // У каждой полки свой оттенок от салатового до голубого, постоянный для категории
  details.style.setProperty('--hue', String(90 + [...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7) % 130));
  const name = el('span', { class: 'group-name' });
  const icon = el('span', { class: 'group-icon', ariaHidden: 'true' }, categoryIcon(id));
  const count = el('span', { class: 'group-count' });
  const strip = el('span', { class: 'strip' });
  const grid = el('div', { class: 'grid' });
  const save = el('button', {
    class: 'secondary save-group',
    onclick: () => {
      const group = groups().find((g) => g.id === id);
      if (group) saveZip([group], `${safe(categoryName(id))}.zip`);
    },
  });
  details.append(el('summary', {}, [icon, name, count, strip]), grid, save);
  details.addEventListener('toggle', () => {
    if (details.open === state.open.has(id)) return;
    if (details.open) state.open.add(id); else state.open.delete(id);
    render();
  });
  const entry = { details, name, count, strip, grid, save, stripKey: '', gridKey: '' };
  view.groups.set(id, entry);
  return entry;
}

function render() {
  const list = groups();
  const failed = state.photos.filter((p) => p.stage === 'failed').length;
  $('#intro').hidden = state.photos.length > 0;
  $('#actions').hidden = state.photos.length === 0;
  $('#panel-groups').hidden = state.photos.length === 0;
  $('#save-all').disabled = state.busy || list.length === 0;
  $('#to-albums').disabled = state.busy || list.length === 0;
  $('#albums').hidden = list.length === 0;
  for (const button of document.querySelectorAll('#test-one, #test-albums, #test-add, #test-remove')) {
    button.disabled = state.busy;
  }
  $('#stages').dataset.stage = !state.photos.length ? '1' : state.busy ? '2' : '3';
  if (list.length) renderAlbums();
  setText($('#summary'), state.photos.length
    ? `${state.photos.length} фото, категорий: ${list.length}` + (failed ? `. Не удалось открыть: ${failed}` : '')
    : '');

  const live = new Set(list.map((g) => g.id));
  for (const [id, g] of view.groups) {
    if (!live.has(id)) {
      g.details.remove();
      view.groups.delete(id);
    }
  }
  const listed = new Set(state.photos.map((p) => p.id));
  for (const [id, cell] of view.cells) {
    if (!listed.has(id)) {
      cell.remove();
      view.cells.delete(id);
    }
  }

  const container = $('#groups');
  list.forEach((group, index) => {
    const g = groupView(group.id);
    const title = categoryName(group.id);
    setText(g.name, title);
    setText(g.count, String(group.photos.length));
    if (g.details.open !== state.open.has(group.id)) g.details.open = state.open.has(group.id);

    const first = group.photos.slice(0, 4);
    const stripKey = first.map((p) => p.thumb).join();
    if (stripKey !== g.stripKey) {
      g.strip.replaceChildren(...first.filter((p) => p.thumb).map((p) => el('img', { src: p.thumb, alt: '' })));
      g.stripKey = stripKey;
    }
    // Сетку строим только у открытой группы
    if (g.details.open) {
      const cells = group.photos.map(cellFor);
      const gridKey = group.photos.map((p) => p.id).join();
      if (gridKey !== g.gridKey) {
        g.grid.replaceChildren(...cells);
        g.gridKey = gridKey;
      }
    } else if (g.gridKey) {
      g.grid.replaceChildren();
      g.gridKey = '';
    }
    g.save.disabled = state.busy;
    setText(g.save, `Скачать «${title}» в «Файлы»`);

    if (container.children[index] !== g.details) container.insertBefore(g.details, container.children[index] || null);
  });
}

function openPhoto(photo) {
  const dialog = $('#photo');
  const url = URL.createObjectURL(photo.file);
  const select = el('select', {
    onchange: () => {
      photo.userCategory = select.value === autoCategory(photo) ? null : select.value;
      persist(photo);
      render();
      fill();
    },
  }, [...state.taxonomy.categories, { id: OTHER, name: categoryName(OTHER) }]
    .map((c) => el('option', { value: c.id, selected: c.id === categoryOf(photo) }, c.name)));

  const fill = () => {
    const rows = [
      ['Что на фото', `${photo.label} (${Math.round(photo.labelConfidence * 100)}%)`],
      ...(autoCategory(photo) === OTHER ? [['Модель сомневается', guesses(photo)
        .map(([id, p]) => `${categoryName(id)} ${Math.round(p * 100)}%`).join(' или ')]] : []),
      ['Дата', photo.date ? photo.date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }) : 'нет в файле'],
      ['Место', photo.place || (photo.latitude != null ? 'не нашлось города рядом' : 'нет геометки')],
    ];
    if (photo.topic) rows.push(['Тема текста', photo.topic]);
    if (photo.lines.length) rows.push(['Главная строка', photo.lines[0].slice(0, 120)]);
    const body = [
      el('img', { class: 'preview', src: url, alt: '' }),
      el('p', { class: 'name' }, proposedName(photo)),
      el('label', { class: 'field' }, ['Категория', select]),
      el('dl', {}, rows.flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, v)])),
    ];
    if (photo.lines.length) {
      body.push(el('details', { class: 'text' }, [el('summary', {}, 'Весь текст на фото'), el('pre', {}, photo.lines.join('\n'))]));
    } else if (photo.textSkipped) {
      body.push(el('button', {
        class: 'secondary', onclick: () => {
          photo.forceText = true;
          photo.stage = 'image';
          persist(photo);
          dialog.close();
          run();
        },
      }, 'Прочитать текст на этом фото'));
    } else if (photo.stage === 'done') {
      body.push(el('p', { class: 'muted' }, 'Текста на фото не нашлось.'));
    }
    $('#photo-body').replaceChildren(...body);
  };
  fill();
  dialog.onclose = () => URL.revokeObjectURL(url);
  dialog.showModal();
}

// ---------- Старт ----------

async function start() {
  try {
    const [taxonomy, manifest] = await Promise.all([
      fetchOk(new URL('taxonomy.json', MODELS)).then((r) => r.json()),
      fetchOk(new URL('manifest.json', MODELS)).then((r) => r.json()),
    ]);
    state.taxonomy = taxonomy;
    state.manifest = manifest;
    [state.categories, state.labels] = await Promise.all([
      loadMatrix('categories.f32', taxonomy.categories.length),
      loadMatrix('labels.f32', taxonomy.labels.length),
    ]);
    pruneModelCache([...manifest.image.parts, ...manifest.topic.parts].map((p) => new URL(p, MODELS).href));
    $('#sizes').textContent = `При первом запуске загрузится модель для фото (${megabytes(manifest.image.size)} МБ), а если на фото есть текст, ещё модель для его темы (${megabytes(manifest.topic.size)} МБ). Лучше по Wi-Fi.`;
    await restore();
    $('#pick').disabled = false;
    render();
    if (state.photos.some(unfinished)) run();
  } catch (error) {
    setStatus(`Не удалось загрузить данные: ${error.message || error}`);
  }
}

$('#files').addEventListener('change', (event) => {
  const files = [...event.target.files];
  event.target.value = '';
  addFiles(files);
});
for (const button of document.querySelectorAll('[data-pick]')) {
  button.addEventListener('click', () => $('#files').click());
}
$('#save-all').addEventListener('click', () => saveZip(groups(), `По полочкам ${isoDate(new Date())}.zip`));
$('#clear').addEventListener('click', clearAll);
$('#to-albums').addEventListener('click', toAlbums);
$('#test-albums').addEventListener('click', testShortcut);
$('#test-add').addEventListener('click', testAddShortcut);
$('#test-remove').addEventListener('click', testRemoveShortcut);
$('#test-one').addEventListener('click', testOne);
$('#toast-close').addEventListener('click', () => showNote(''));
setupMode();
setupAllMade();
setupPanels();
setupRemoveSource();
setupShortcutName();
setupInstall();
$('#photo-close').addEventListener('click', () => $('#photo').close());
document.addEventListener('visibilitychange', () => { if (state.busy) keepAwake(true); });
// Без этого Safari на iPhone не подсвечивает нажатую кнопку
document.addEventListener('touchstart', () => {}, { passive: true });

start();
