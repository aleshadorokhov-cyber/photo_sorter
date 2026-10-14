// По полочкам, веб-версия. Всё считается в браузере: фото никуда не отправляются.
import * as exifr from './vendor/exifr/lite.esm.mjs';
import Tesseract from './vendor/tesseract/tesseract.esm.min.js';
import { clipPixels, decode, ocrImage, thumbnail } from './images.js';
import { pruneModelCache } from './models.js';
import * as store from './store.js';
import { crc32, zipBlob } from './zip.js';

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

function categoryOf(photo) {
  return photo.userCategory || photo.category;
}

function categoryName(id) {
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
  const worker = new TaskWorker('./image-worker.js');
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
  const worker = new TaskWorker('./image-worker.js');
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
  const worker = new TaskWorker('./topic-worker.js');
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
  // IMG_E1234 — отредактированная копия, в галерее она называется IMG_1234
  return base.replace(/^IMG_E(\d+)$/i, 'IMG_$1');
}

function albumPlan() {
  const plan = {};
  let photos = 0, skipped = 0;
  for (const group of groups()) {
    const names = [...new Set(group.photos.map(libraryName).filter(Boolean))];
    skipped += group.photos.length - group.photos.filter(libraryName).length;
    if (!names.length) continue;
    plan[`Сортировка: ${categoryName(group.id)}`] = names;
    photos += names.length;
  }
  return { plan, albums: Object.keys(plan).length, photos, skipped };
}

async function toAlbums() {
  const { plan, albums, photos, skipped } = albumPlan();
  const note = $('#albums-note');
  if (!albums) {
    note.textContent = 'Ни один снимок не найти по имени файла.';
    return;
  }
  try {
    await navigator.clipboard.writeText(JSON.stringify(plan));
  } catch {
    note.textContent = 'Safari не дал скопировать список. Нажмите кнопку ещё раз.';
    return;
  }
  const name = shortcutName();
  note.textContent = `Скопировал раскладку: альбомов ${albums}, фото ${photos}.`
    + (skipped ? ` Без имени файла и не попадут в альбомы: ${skipped}.` : '')
    + ` Открываю команду «${name}». Если Shortcuts пишут, что её нет (Could not find the shortcut),`
    + ' сначала соберите её по шагам ниже или впишите там её точное имя.';
  // Шаги остаются открытыми, когда вы вернётесь из Shortcuts
  $('#shortcut-help').open = true;
  location.href = `shortcuts://run-shortcut?name=${encodeURIComponent(name)}`;
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
  return list.sort((a, b) => b.photos.length - a.photos.length || categoryName(a.id).localeCompare(categoryName(b.id), 'ru'));
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
  const name = el('span', { class: 'group-name' });
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
  details.append(el('summary', {}, [name, count, strip]), grid, save);
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
  $('#summary-row').hidden = state.photos.length === 0;
  $('#save-all').disabled = state.busy || list.length === 0;
  $('#albums').hidden = list.length === 0;
  $('#to-albums').disabled = state.busy;
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
    setText(g.save, `Сохранить «${title}» в «Файлы»`);

    if (container.children[index] !== g.details) container.insertBefore(g.details, container.children[index] || null);
  });
}

function openPhoto(photo) {
  const dialog = $('#photo');
  const url = URL.createObjectURL(photo.file);
  const select = el('select', {
    onchange: () => {
      photo.userCategory = select.value === photo.category ? null : select.value;
      persist(photo);
      render();
      fill();
    },
  }, state.taxonomy.categories.map((c) => el('option', { value: c.id, selected: c.id === categoryOf(photo) }, c.name)));

  const fill = () => {
    const rows = [
      ['Что на фото', `${photo.label} (${Math.round(photo.labelConfidence * 100)}%)`],
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
setupShortcutName();
$('#photo-close').addEventListener('click', () => $('#photo').close());
document.addEventListener('visibilitychange', () => { if (state.busy) keepAwake(true); });
// Без этого Safari на iPhone не подсвечивает нажатую кнопку
document.addEventListener('touchstart', () => {}, { passive: true });

start();
