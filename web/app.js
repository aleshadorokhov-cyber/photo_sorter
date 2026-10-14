// По полочкам, веб-версия. Всё считается в браузере: фото никуда не отправляются.
import * as exifr from './vendor/exifr/lite.esm.mjs';
import Tesseract from './vendor/tesseract/tesseract.esm.min.js';
import { Zip, ZipPassThrough } from './vendor/fflate/browser.js';

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

// ---------- Картинки ----------

async function decode(file) {
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
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
}

function canvas(width, height) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(width));
  c.height = Math.max(1, Math.round(height));
  return c;
}

// Уменьшает в несколько шагов, чтобы мелкие детали не превращались в шум
function scaled(source, sx, sy, sw, sh, width, height) {
  let current = source;
  let cx = sx, cy = sy, cw = sw, ch = sh;
  while (cw / 2 >= width * 1.5 && ch / 2 >= height * 1.5) {
    const step = canvas(cw / 2, ch / 2);
    const ctx = step.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(current, cx, cy, cw, ch, 0, 0, step.width, step.height);
    current = step; cx = 0; cy = 0; cw = step.width; ch = step.height;
  }
  const out = canvas(width, height);
  const ctx = out.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(current, cx, cy, cw, ch, 0, 0, out.width, out.height);
  return out;
}

// Как в CLIP: квадрат по центру короткой стороны, 224x224, значения 0..1 по каналам
function clipPixels(bitmap) {
  const side = Math.min(bitmap.width, bitmap.height);
  const c = scaled(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 224, 224);
  const { data } = c.getContext('2d').getImageData(0, 0, 224, 224);
  const plane = 224 * 224;
  const pixels = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    pixels[i] = data[i * 4] / 255;
    pixels[plane + i] = data[i * 4 + 1] / 255;
    pixels[2 * plane + i] = data[i * 4 + 2] / 255;
  }
  return pixels;
}

function fit(bitmap, maxSide) {
  const s = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  return scaled(bitmap, 0, 0, bitmap.width, bitmap.height, bitmap.width * s, bitmap.height * s);
}

function thumbnail(bitmap) {
  return new Promise((resolve) => fit(bitmap, 360).toBlob((blob) => resolve(URL.createObjectURL(blob)), 'image/jpeg', 0.8));
}

// Для чтения текста: не больше 2000 точек, мелкие снимки увеличиваются вдвое
function ocrCanvas(bitmap) {
  const longest = Math.max(bitmap.width, bitmap.height);
  if (longest < 1200) return scaled(bitmap, 0, 0, bitmap.width, bitmap.height, bitmap.width * 2, bitmap.height * 2);
  return fit(bitmap, 2000);
}

// ---------- Дата, место, скриншот ----------

function commentText(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  try { return new TextDecoder().decode(value); } catch { return ''; }
}

async function readMeta(file) {
  let tags = {};
  try {
    tags = (await exifr.parse(file, { tiff: true, exif: true, gps: true, xmp: false, icc: false, iptc: false, jfif: false, ihdr: false })) || {};
  } catch { /* у файла нет EXIF */ }
  const date = tags.DateTimeOriginal || tags.CreateDate || null;
  const comment = commentText(tags.UserComment);
  const isScreenshot = /screenshot/i.test(comment) || (file.type === 'image/png' && !tags.Make);
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

// ---------- Модели ----------

class ImageModel {
  constructor() {
    this.worker = new Worker(new URL('./clip-worker.js', BASE), { type: 'module' });
    this.pending = new Map();
    this.worker.onmessage = ({ data }) => {
      if (data.type === 'progress') this.onProgress?.(data.loaded, data.total);
      else if (data.type === 'loaded') this.loaded?.resolve();
      else if (data.type === 'error' && data.id == null) this.loaded?.reject(new Error(data.message));
      else {
        const task = this.pending.get(data.id);
        this.pending.delete(data.id);
        if (data.type === 'error') task?.reject(new Error(data.message));
        else task?.resolve(data.vector);
      }
    };
    this.counter = 0;
  }

  load(onProgress) {
    this.onProgress = onProgress;
    return new Promise((resolve, reject) => {
      this.loaded = { resolve, reject };
      const { parts, size } = state.manifest.image;
      this.worker.postMessage({ type: 'load', urls: parts.map((p) => new URL(p, MODELS).href), size });
    });
  }

  embed(pixels) {
    const id = ++this.counter;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ type: 'embed', id, pixels }, [pixels.buffer]);
    });
  }

  close() {
    this.worker.terminate();
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

// EmbeddingGemma лежит частями (на GitHub Pages один файл не больше 100 МБ), склеиваем потоком
async function createTopicModel(onProgress) {
  const { FilesetResolver, TextEmbedder } = await import('./vendor/mediapipe/text_bundle.mjs');
  const fileset = await FilesetResolver.forTextTasks(new URL('vendor/mediapipe', BASE).href);
  const parts = state.manifest.topic.parts.map((p) => new URL(p, MODELS));
  const total = state.manifest.topic.size;
  let index = 0, loaded = 0, reader = null;
  const stream = new ReadableStream({
    async pull(controller) {
      for (;;) {
        if (!reader) {
          if (index >= parts.length) { controller.close(); return; }
          reader = (await fetchOk(parts[index++])).body.getReader();
        }
        const { done, value } = await reader.read();
        if (done) { reader = null; continue; }
        loaded += value.length;
        onProgress(loaded, total);
        controller.enqueue(value);
        return;
      }
    },
  });
  return TextEmbedder.createFromOptions(fileset, { baseOptions: { modelAssetBuffer: stream.getReader() } });
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

async function analyzeImages() {
  const todo = state.photos.filter((p) => p.stage === 'new');
  if (!todo.length) return;
  const model = new ImageModel();
  try {
    await model.load((loaded, total) => setStatus(
      `Загружаю модель для фото: ${megabytes(loaded)} из ${megabytes(total || state.manifest.image.size)} МБ. Это нужно один раз.`,
      total ? loaded / total : null));
    let done = 0;
    for (const photo of todo) {
      setStatus(`Смотрю, что на фото: ${done + 1} из ${todo.length}`, done / todo.length);
      try {
        const meta = await readMeta(photo.file);
        Object.assign(photo, meta);
        const bitmap = await decode(photo.file);
        photo.thumb = await thumbnail(bitmap);
        const pixels = clipPixels(bitmap);
        bitmap.close?.();
        const vector = normalize(await model.embed(pixels));
        photo.probabilities = probabilities(state.categories, vector);
        const c = argmax(photo.probabilities);
        photo.category = photo.isScreenshot ? 'screenshots' : state.taxonomy.categories[c].id;
        photo.confidence = photo.isScreenshot ? 1 : photo.probabilities[c];
        const labels = probabilities(state.labels, vector);
        const l = argmax(labels);
        photo.label = state.taxonomy.labels[l].ru;
        photo.labelConfidence = labels[l];
        if (photo.latitude != null) {
          try { photo.place = await placeName(photo.latitude, photo.longitude); } catch { photo.place = null; }
        }
        photo.stage = 'image';
      } catch (error) {
        console.error(error);
        photo.stage = 'failed';
        photo.error = String(error.message || error);
      }
      done++;
      scheduleRender();
    }
  } finally {
    model.close();
  }
}

async function analyzeText() {
  const todo = state.photos.filter((p) => p.stage === 'image' && needsText(p));
  state.photos.filter((p) => p.stage === 'image' && !needsText(p)).forEach((p) => { p.stage = 'done'; p.textSkipped = true; });
  if (!todo.length) return;
  setStatus('Загружаю распознавание текста…');
  const reader = await createTextReader();
  try {
    let done = 0;
    for (const photo of todo) {
      setStatus(`Читаю текст: ${done + 1} из ${todo.length}`, done / todo.length);
      try {
        const bitmap = await decode(photo.file);
        const c = ocrCanvas(bitmap);
        bitmap.close?.();
        const { data } = await reader.recognize(c, {}, { blocks: true, text: true });
        photo.lines = readText(data);
        photo.textSkipped = false;
        photo.stage = photo.lines.length ? 'text' : 'done';
      } catch (error) {
        console.error(error);
        photo.stage = 'done';
      }
      done++;
      scheduleRender();
    }
  } finally {
    await reader.terminate();
  }
}

async function analyzeTopics() {
  const todo = state.photos.filter((p) => p.stage === 'text');
  if (!todo.length) return;
  if (!state.topics) state.topics = await loadMatrix('topics.f32', state.taxonomy.topics.length);
  let model;
  try {
    model = await createTopicModel((loaded, total) => setStatus(
      `Загружаю модель для темы текста: ${megabytes(loaded)} из ${megabytes(total)} МБ. Это нужно один раз.`, loaded / total));
  } catch (error) {
    console.error(error);
    todo.forEach((p) => { p.stage = 'done'; p.topicError = true; });
    return;
  }
  try {
    let done = 0;
    for (const photo of todo) {
      setStatus(`Определяю тему текста: ${done + 1} из ${todo.length}`, done / todo.length);
      await new Promise((r) => setTimeout(r, 30));
      const text = photo.lines.join(' ').slice(0, 600);
      const vector = normalize(model.embed(TOPIC_PREFIX + text).embeddings[0].floatEmbedding);
      const s = scores(state.topics, vector);
      photo.topic = state.taxonomy.topics[argmax(s)];
      photo.stage = 'done';
      done++;
      scheduleRender();
    }
  } finally {
    model.close();
  }
}

async function run() {
  if (state.busy) return;
  state.busy = true;
  render();
  try {
    while (state.photos.some((p) => p.stage === 'new' || p.stage === 'image' || p.stage === 'text')) {
      await analyzeImages();
      await analyzeText();
      await analyzeTopics();
    }
    setStatus('');
  } catch (error) {
    console.error(error);
    setStatus(`Ошибка: ${error.message || error}. Попробуйте обновить страницу.`);
  } finally {
    state.busy = false;
    render();
  }
}

function addFiles(files) {
  for (const file of files) {
    if (!file.type.startsWith('image/') && !/\.(heic|heif|jpe?g|png)$/i.test(file.name)) continue;
    state.photos.push({ id: state.nextId++, file, stage: 'new', lines: [] });
  }
  render();
  run();
}

// ---------- Сохранение ----------

function extension(file) {
  const match = /\.([a-z0-9]+)$/i.exec(file.name);
  if (match) return match[1].toLowerCase() === 'jpeg' ? 'jpg' : match[1].toLowerCase();
  return { 'image/png': 'png', 'image/heic': 'heic' }[file.type] || 'jpg';
}

function safe(name) {
  return name.replace(/[\/\\:*?"<>|]/g, '-').trim() || 'Фото';
}

async function saveZip(groups, zipName) {
  setStatus('Собираю архив…');
  const blob = await new Promise(async (resolve, reject) => {
    const chunks = [];
    const zip = new Zip((error, chunk, final) => {
      if (error) { reject(error); return; }
      chunks.push(chunk);
      if (final) resolve(new Blob(chunks, { type: 'application/zip' }));
    });
    try {
      for (const group of groups) {
        const used = new Set();
        const folder = safe(categoryName(group.id));
        for (const photo of group.photos) {
          const ext = extension(photo.file);
          const base = safe(proposedName(photo));
          let name = `${base}.${ext}`;
          for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base} (${n}).${ext}`;
          used.add(name.toLowerCase());
          const entry = new ZipPassThrough(`${folder}/${name}`);
          entry.mtime = photo.date || new Date();
          zip.add(entry);
          entry.push(new Uint8Array(await photo.file.arrayBuffer()), true);
        }
      }
      zip.end();
    } catch (error) {
      reject(error);
    }
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = zipName;
  document.body.appendChild(link);
  link.click();
  setTimeout(() => { link.remove(); URL.revokeObjectURL(url); }, 120000);
  setStatus(state.busy ? $('#status-text').textContent : '');
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

function render() {
  const list = groups();
  const failed = state.photos.filter((p) => p.stage === 'failed').length;
  $('#intro').hidden = state.photos.length > 0;
  $('#actions').hidden = state.photos.length === 0;
  $('#save-all').disabled = state.busy || list.length === 0;
  $('#summary').textContent = state.photos.length
    ? `${state.photos.length} фото, категорий: ${list.length}` + (failed ? `. Не удалось открыть: ${failed}` : '')
    : '';

  const container = $('#groups');
  container.replaceChildren(...list.map((group) => {
    const details = el('details', { class: 'group', open: state.open.has(group.id) });
    details.addEventListener('toggle', () => {
      if (details.open) state.open.add(group.id); else state.open.delete(group.id);
    });
    const strip = group.photos.slice(0, 4).map((p) => el('img', { src: p.thumb, alt: '' }));
    details.append(
      el('summary', {}, [
        el('span', { class: 'group-name' }, categoryName(group.id)),
        el('span', { class: 'group-count' }, String(group.photos.length)),
        el('span', { class: 'strip' }, strip),
      ]),
      el('div', { class: 'grid' }, group.photos.map((p) => el('button', {
        class: 'cell', onclick: () => openPhoto(p), title: proposedName(p),
      }, [el('img', { src: p.thumb, alt: proposedName(p), loading: 'lazy' })]))),
      el('button', {
        class: 'secondary save-group', disabled: state.busy,
        onclick: () => saveZip([group], `${safe(categoryName(group.id))}.zip`),
      }, `Сохранить «${categoryName(group.id)}» в «Файлы»`),
    );
    return details;
  }));
}

function openPhoto(photo) {
  const dialog = $('#photo');
  const url = URL.createObjectURL(photo.file);
  const select = el('select', {
    onchange: () => {
      photo.userCategory = select.value === photo.category ? null : select.value;
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
    $('#sizes').textContent = `При первом запуске загрузится модель для фото (${megabytes(manifest.image.size)} МБ), а если на фото есть текст, ещё модель для его темы (${megabytes(manifest.topic.size)} МБ). Лучше по Wi-Fi.`;
    $('#pick').disabled = false;
  } catch (error) {
    setStatus(`Не удалось загрузить данные: ${error.message || error}`);
  }
}

$('#files').addEventListener('change', (event) => {
  addFiles([...event.target.files]);
  event.target.value = '';
});
for (const button of document.querySelectorAll('[data-pick]')) {
  button.addEventListener('click', () => $('#files').click());
}
$('#save-all').addEventListener('click', () => saveZip(groups(), `По полочкам ${isoDate(new Date())}.zip`));
$('#photo-close').addEventListener('click', () => $('#photo').close());
window.addEventListener('beforeunload', (event) => {
  if (state.photos.length) event.preventDefault();
});

start();
