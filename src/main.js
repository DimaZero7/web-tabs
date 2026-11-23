// web-tabs — доска с сеткой точек (как в MyScript Notes) и блоками нот.
import { songMetrics, layoutBlock } from './layout.js';
import { drawGrid, drawItems, makeMeasure } from './draw.js';
import { storage, emptySong } from './storage.js';
import { openPlayer } from './player.js';

const CELL_100 = 5 * 96 / 25.4;        // клетка 5 мм в CSS-пикселях = масштаб 100%
const Z_MIN = CELL_100 * 0.25, Z_MAX = CELL_100 * 10;
const $ = id => document.getElementById(id);
const canvas = $('board'), ctx = canvas.getContext('2d');
const measure = makeMeasure();

const state = {
  songId: null, song: null, mtime: 0, saving: false, dirtySince: 0,
  cam: { x: -1, y: -1, z: CELL_100 * 2 }, locked: false,
  selected: null, history: [], future: [],
  boxes: [],                                         // где какой блок: { id, x, y, w, h, lay }
};

// ---------- данные ----------
const CREATE = '__create__', FOLDER = '__folder__';
let folderName = '';
let songList = [];

// Список песен. На планшете — все песни из подключённой папки на Google Диске.
async function loadSongList(selectId) {
  const list = await storage.list();
  songList = list;
  const sel = $('song');
  const extra = storage.kind === 'android'
    ? `<option value="${CREATE}">＋ Новая песня…</option>` +
      `<option value="${FOLDER}">📁 Папка «${escapeHtml(folderName)}» — сменить…</option>` : '';
  sel.innerHTML = list.map(s => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.title)}</option>`).join('') + extra;
  const want = selectId || state.songId || new URLSearchParams(location.search).get('song') || localStorage.getItem('wt-song');
  state.songId = list.some(s => s.id === want) ? want : list[0]?.id || null;
  sel.value = state.songId ?? '';
  return list;
}
const sameList = (a, b) => a.length === b.length && a.every((x, i) => x.id === b[i].id && x.title === b[i].title);

async function loadSong(keepView) {
  const song = await storage.read(state.songId);
  state.mtime = await storage.mtime(state.songId).catch(() => 0);
  song.blocks ||= [];
  state.song = song;
  for (const [i, b] of song.blocks.entries()) b.id ||= 'b' + (i + 1);
  $('title').textContent = song.title || '';
  setStatus('');
  document.title = (song.title || 'песня') + ' — web-tabs';
  $('video').hidden = !song.video;
  if (song.video) $('video').href = song.video;
  if (!keepView) fitWidth();
  syncPanel();
  render();
}

// Сохранение в файл песни (с задержкой, чтобы не писать на каждую букву)
let saveTimer = 0;
function scheduleSave() {
  setStatus('изменено…');
  clearTimeout(saveTimer);
  state.dirtySince ||= Date.now();
  saveTimer = setTimeout(save, 600);
}
async function save() {
  if (!state.songId) return;
  state.saving = true;
  try {
    state.mtime = await storage.write(state.songId, state.song);
    state.dirtySince = 0;
    setStatus('сохранено');
  } catch (e) {
    setStatus('не сохранилось: ' + e.message);
  } finally { state.saving = false; }
}

// ---------- синхронизация (как в MyScript: кнопка ⟳ и автоматически) ----------
// Сначала отправляем свои несохранённые правки, потом берём свежую версию файла
// (на Android Google Диск подтягивает её из облака) и показываем, если она другая.
const hhmm = () => new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
let syncing = false;
async function syncNow(manual = false) {
  if (syncing || document.hidden || !$('setup').hidden) return;
  if (!manual && (drag || pinch || isTyping())) return;  // не мешаем, пока человек работает
  syncing = true;
  $('sync').classList.add('spin');
  try {
    if (state.dirtySince) { clearTimeout(saveTimer); await save(); }
    // список песен: новые файлы в папке появляются сами
    const fresh = await storage.list();
    if (!sameList(fresh, songList)) {
      const had = state.songId;
      await loadSongList(had);
      if (state.songId !== had) {                       // текущую песню удалили — открыть другую
        state.selected = null; state.history = []; state.future = []; updateUndo();
        if (state.songId) await loadSong(false); else { state.song = null; syncPanel(); render(); }
      }
    }
    if (!state.songId) { setStatus('в папке нет песен — «＋ Новая песня…»'); return; }
    const { song, mtime } = await storage.sync(state.songId);
    song.blocks ||= [];
    for (const [i, b] of song.blocks.entries()) b.id ||= 'b' + (i + 1);
    const changed = JSON.stringify(song) !== JSON.stringify(state.song);
    if (changed && !state.dirtySince) {
      state.song = song; state.mtime = mtime;
      if (!state.song.blocks.some(b => b.id === state.selected)) state.selected = null;
      state.history = []; state.future = []; updateUndo();   // отмена не должна затирать чужую правку
      $('title').textContent = song.title || '';
      syncPanel(); render();
      setStatus('обновлено с Диска ' + hhmm());
    } else {
      setStatus('синхронизировано ' + hhmm());
    }
  } catch (e) {
    setStatus('нет синхронизации: ' + e.message);
  } finally {
    syncing = false;
    $('sync').classList.remove('spin');
  }
}
const isTyping = () => /^(TEXTAREA|INPUT)$/.test(document.activeElement?.tagName);
$('sync').onclick = () => syncNow(true);
// автоматически: при возвращении в приложение и периодически
document.addEventListener('visibilitychange', () => { if (!document.hidden) syncNow(); });
setInterval(() => syncNow(), storage.kind === 'android' ? 30000 : 3000);

// ---------- отмена ----------
function commit() {                                   // запомнить состояние ДО изменения
  state.history.push(JSON.stringify(state.song));
  if (state.history.length > 200) state.history.shift();
  state.future = [];
  updateUndo();
}
function undo(redo = false) {
  const from = redo ? state.future : state.history, to = redo ? state.history : state.future;
  if (!from.length) return;
  to.push(JSON.stringify(state.song));
  state.song = JSON.parse(from.pop());
  if (!state.song.blocks.some(b => b.id === state.selected)) state.selected = null;
  syncPanel(); render(); scheduleSave(); updateUndo();
}
function updateUndo() {
  $('undo').disabled = !state.history.length;
  $('redo').disabled = !state.future.length;
}

// ---------- вид ----------
function fitWidth() {
  const { width } = songMetrics(state.song, measure);
  const blocks = state.song.blocks;
  const minX = Math.min(1, ...blocks.map(b => b.x)), minY = Math.min(1, ...blocks.map(b => b.y));
  const panel = $('panel').hidden ? 0 : 380;
  const avail = canvas.clientWidth - panel - 40;
  state.cam.z = clamp(avail / (width + 2), Z_MIN, Z_MAX);
  state.cam.x = minX - 1;
  state.cam.y = minY - 1;
  render();
}
function zoomAt(factor, sx, sy) {
  const c = state.cam;
  const z = clamp(c.z * factor, Z_MIN, Z_MAX);
  const wx = c.x + sx / c.z, wy = c.y + sy / c.z;    // точка доски под курсором остаётся на месте
  c.z = z; c.x = wx - sx / z; c.y = wy - sy / z;
  render();
}

// ---------- отрисовка ----------
let raf = 0;
function render() { if (!raf) raf = requestAnimationFrame(draw); }
function draw() {
  raf = 0;
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(canvas.clientWidth * dpr), h = Math.round(canvas.clientHeight * dpr);
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  const cam = state.cam;
  drawGrid(ctx, cam, w, h, dpr);
  $('zoom-pct').textContent = Math.round(cam.z / CELL_100 * 100) + '%';
  if (!state.song) return;
  const metrics = songMetrics(state.song, measure);
  state.boxes = [];
  for (const b of state.song.blocks) {
    const lay = layoutBlock(b, metrics, measure);
    state.boxes.push({ id: b.id, x: b.x, y: b.y, w: lay.w, h: lay.h, lay });
    const ox = (b.x - cam.x) * cam.z * dpr, oy = (b.y - cam.y) * cam.z * dpr;
    drawItems(ctx, lay.items, ox, oy, cam.z * dpr);
    if (b.id === state.selected) {                   // выделение — как в MyScript
      const p = 0.35 * cam.z * dpr;
      ctx.strokeStyle = '#1a8bff'; ctx.lineWidth = 2 * dpr; ctx.setLineDash([]);
      ctx.strokeRect(ox - p, oy - p, lay.w * cam.z * dpr + 2 * p, lay.h * cam.z * dpr + 2 * p);
    }
  }
}

// ---------- мышь, тачпад, клавиатура ----------
const toCell = (sx, sy) => ({ x: state.cam.x + sx / state.cam.z, y: state.cam.y + sy / state.cam.z });
const hit = (sx, sy) => {
  const p = toCell(sx, sy);
  return [...state.boxes].reverse().find(b => p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h);
};

// координаты курсора на холсте (offsetX ненадёжен при масштабировании экрана)
const pos = e => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };

let drag = null;
const touches = new Map();                            // активные пальцы: id → { x, y }
let pinch = null;                                     // два пальца: масштаб и сдвиг доски

canvas.addEventListener('pointerdown', e => {
  const p = pos(e);
  canvas.setPointerCapture(e.pointerId);
  touches.set(e.pointerId, p);
  if (touches.size === 2) {                           // второй палец — переходим к щипку
    if (drag?.kind === 'block' && drag.moved) undo();  // начатый перенос блока отменяем
    drag = null;
    const [a, b] = [...touches.values()];
    pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
    return;
  }
  if (touches.size > 2) return;
  const box = hit(p.x, p.y);
  if (box) {
    const bl = block(box.id);
    if (state.selected !== bl.id) { state.selected = bl.id; syncPanel(); }
    drag = { kind: 'block', b: bl, sx: p.x, sy: p.y, bx: bl.x, by: bl.y, moved: false };
  } else {
    drag = { kind: 'pan', sx: p.x, sy: p.y, cx: state.cam.x, cy: state.cam.y, moved: false };
  }
  canvas.classList.add('drag');
  render();
});
canvas.addEventListener('pointermove', e => {
  const p = pos(e);
  if (touches.has(e.pointerId)) touches.set(e.pointerId, p);
  if (pinch && touches.size >= 2) {
    const [a, b] = [...touches.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y), mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    if (!state.locked) {
      state.cam.x -= (mx - pinch.mx) / state.cam.z;   // сдвиг двумя пальцами
      state.cam.y -= (my - pinch.my) / state.cam.z;
      if (pinch.d > 0) zoomAt(d / pinch.d, mx, my);   // щипок — масштаб вокруг середины пальцев
    }
    Object.assign(pinch, { d, mx, my });
    render();
    return;
  }
  if (!drag) { canvas.classList.toggle('over-block', !!hit(p.x, p.y)); return; }
  const dx = (p.x - drag.sx) / state.cam.z, dy = (p.y - drag.sy) / state.cam.z;
  const slop = e.pointerType === 'touch' ? 8 : 3;     // палец дрожит сильнее мыши
  if (Math.abs(p.x - drag.sx) + Math.abs(p.y - drag.sy) > slop) {
    if (!drag.moved && drag.kind === 'block') commit();
    drag.moved = true;
  }
  if (!drag.moved) return;
  if (drag.kind === 'block') {                       // блок двигается по точкам (целыми клетками)
    drag.b.x = Math.round(drag.bx + dx); drag.b.y = Math.round(drag.by + dy);
  } else if (!state.locked) {
    state.cam.x = drag.cx - dx; state.cam.y = drag.cy - dy;
  }
  render();
});
const pointerEnd = e => {
  touches.delete(e.pointerId);
  if (pinch) { if (touches.size < 2) pinch = null; drag = null; canvas.classList.remove('drag'); return; }
  if (drag?.kind === 'block' && drag.moved) scheduleSave();
  if (drag?.kind === 'pan' && !drag.moved && state.selected) { state.selected = null; syncPanel(); render(); }
  drag = null;
  canvas.classList.remove('drag');
};
canvas.addEventListener('pointerup', pointerEnd);
canvas.addEventListener('pointercancel', pointerEnd);
canvas.addEventListener('wheel', e => {
  e.preventDefault();
  if (state.locked) return;
  if (e.ctrlKey || e.metaKey) { const p = pos(e); zoomAt(Math.exp(-e.deltaY * 0.0025), p.x, p.y); }   // щипок тачпада — тоже ctrl+колесо
  else {
    const k = e.deltaMode === 1 ? 16 : 1;
    state.cam.x += (e.shiftKey ? e.deltaY : e.deltaX) * k / state.cam.z;
    state.cam.y += (e.shiftKey ? 0 : e.deltaY) * k / state.cam.z;
    render();
  }
}, { passive: false });
window.addEventListener('resize', render);

window.addEventListener('keydown', e => {
  const typing = /^(TEXTAREA|INPUT|SELECT)$/.test(document.activeElement?.tagName);
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.code === 'KeyZ') { e.preventDefault(); undo(e.shiftKey); return; }
  if (mod && e.code === 'KeyY') { e.preventDefault(); undo(true); return; }
  if (typing) return;
  const b = block(state.selected);
  if (!b) return;
  if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); removeSelected(); }
  else if (mod && e.code === 'KeyD') { e.preventDefault(); duplicate(); }
  else if (e.key.startsWith('Arrow')) {
    e.preventDefault(); commit();
    b.x += e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0;
    b.y += e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0;
    render(); scheduleSave();
  } else if (e.key === 'Escape') { state.selected = null; syncPanel(); render(); }
});

// ---------- блоки ----------
const block = id => state.song?.blocks.find(b => b.id === id);
const newId = () => 'b' + (Math.max(0, ...state.song.blocks.map(b => Number(String(b.id).slice(1)) || 0)) + 1);
function bottomOfAll() {
  const m = songMetrics(state.song, measure);
  return Math.max(-1, ...state.song.blocks.map(b => b.y + layoutBlock(b, m, measure).h));
}
function addBlock() {
  if (!state.song) return;
  commit();
  const x = state.song.blocks[0]?.x ?? 1;
  const b = { id: newId(), x, y: bottomOfAll() + 2, left: '', right: '', reps: [1, 1] };
  state.song.blocks.push(b);
  state.selected = b.id;
  syncPanel(); render(); scheduleSave();
  $('left').focus();
}
function duplicate() {
  const b = block(state.selected); if (!b) return;
  commit();
  const copy = { ...structuredClone(b), id: newId(), y: bottomOfAll() + 2 };
  state.song.blocks.push(copy);
  state.selected = copy.id;
  syncPanel(); render(); scheduleSave();
}
function removeSelected() {
  if (!block(state.selected)) return;
  commit();
  state.song.blocks = state.song.blocks.filter(b => b.id !== state.selected);
  state.selected = null;
  syncPanel(); render(); scheduleSave();
  setStatus('блок удалён — Ctrl+Z вернёт');
}

// ---------- панель блока ----------
function syncPanel() {
  const b = block(state.selected);
  $('panel').hidden = !b;
  if (!b) return;
  const n = state.song.blocks.indexOf(b) + 1;
  $('panel-title').textContent = `Блок ${n}`;
  for (const [id, val] of [['left', b.left], ['right', b.right], ['rep-left', b.reps?.[0] ?? 1], ['rep-right', b.reps?.[1] ?? 1]]) {
    if (document.activeElement !== $(id)) $(id).value = val;
  }
  showErrors(b);
}
function showErrors(b) {
  const lay = layoutBlock(b, songMetrics(state.song, measure), measure);
  $('errors').innerHTML = lay.errors.map(e => `<li>${escapeHtml(e)}</li>`).join('');
}
let editing = null;                                   // одна правка поля = один шаг отмены
for (const id of ['left', 'right', 'rep-left', 'rep-right']) {
  $(id).addEventListener('focus', () => { editing = null; });
  $(id).addEventListener('input', () => {
    const b = block(state.selected); if (!b) return;
    if (editing !== id) { commit(); editing = id; }
    if (id === 'left' || id === 'right') b[id] = $(id).value;
    else {
      b.reps = [...(b.reps || [1, 1])];
      b.reps[id === 'rep-left' ? 0 : 1] = Number($(id).value) || 0;
    }
    showErrors(b); render(); scheduleSave();
  });
}

// ---------- кнопки ----------
$('add').onclick = addBlock;
// Режим «на пианино»: кнопка в панели блока или двойной клик / двойное касание по блоку
const showPiano = id => { const b = block(id); if (b) openPlayer({ song: state.song, block: b, measure }); };
$('piano').onclick = () => showPiano(state.selected);
canvas.addEventListener('dblclick', e => { const p = pos(e); const box = hit(p.x, p.y); if (box) showPiano(box.id); });
$('dup').onclick = duplicate;
$('del').onclick = removeSelected;
$('undo').onclick = () => undo(false);
$('redo').onclick = () => undo(true);
$('zoom-pct').onclick = fitWidth;
$('lock').onclick = () => {
  state.locked = !state.locked;
  $('lock').textContent = state.locked ? '🔒' : '🔓';
  $('lock').title = state.locked ? 'Вид закреплён — открыть' : 'Закрепить вид';
};
$('song').onchange = async e => {
  const v = e.target.value;
  try {
    if (v === FOLDER) { await connectFolder(); return; }
    if (v === CREATE) {
      const title = prompt('Название песни', 'Новая песня');
      if (!title) { $('song').value = state.songId ?? ''; return; }
      const f = await storage.create(title);
      await storage.write(f.id, emptySong(title));
      await loadSongList(f.id);
    } else {
      state.songId = v;
    }
    localStorage.setItem('wt-song', state.songId);
    state.selected = null; state.history = []; state.future = []; updateUndo();
    await loadSong(false);
  } catch (err) {
    $('song').value = state.songId ?? '';
    if (!/отмен/i.test(err.message)) setStatus('ошибка: ' + err.message);
  }
};

// Подключить папку с песнями на Google Диске (один раз; потом — только если сменить)
async function connectFolder() {
  try {
    const f = await storage.pickFolder();
    folderName = f.name || 'папка';
    $('setup').hidden = true;
    state.songId = null; state.song = null; state.selected = null;
    await loadSongList();
    if (state.songId) await loadSong(false);
    else { syncPanel(); render(); setStatus('в папке нет песен — «＋ Новая песня…»'); }
  } catch (err) {
    $('song').value = state.songId ?? '';
    if (!/отмен/i.test(err.message)) setStatus('ошибка: ' + err.message);
  }
}
$('setup-btn').onclick = connectFolder;

// PNG блока для вставки в MyScript: клетка = U пикселей, прозрачный фон, поля по полклетки
$('png').onclick = () => {
  const b = block(state.selected) || state.song.blocks[0];
  if (!b) return;
  const U = Number(prompt('Сколько пикселей в одной клетке (5 мм)?', '64')) || 64;
  const lay = layoutBlock(b, songMetrics(state.song, measure), measure);
  const c = document.createElement('canvas');
  c.width = Math.round((lay.w + 1) * U); c.height = Math.round((lay.h + 1) * U);
  drawItems(c.getContext('2d'), lay.items, U / 2, U / 2, U);
  const a = document.createElement('a');
  a.download = `${state.songId}-${b.id}.png`;
  a.href = c.toDataURL('image/png');
  a.click();
};

// ---------- мелочи ----------
function setStatus(t) { $('status').textContent = t; }
function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }
function escapeHtml(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
window.addEventListener('beforeunload', e => { if (state.dirtySince) { save(); e.preventDefault(); } });

if (storage.kind === 'android') $('png').hidden = true;   // скачивание файлов в WebView не работает
window.webTabs = state;                               // для отладки из консоли браузера

// ---------- старт ----------
(async () => {
  try {
    if (storage.kind === 'android') {
      const f = await storage.folder();
      if (!f.uri) { $('setup').hidden = false; render(); return; }   // первый запуск: подключить папку
      folderName = f.name || 'папка';
    }
    await loadSongList();
    if (!state.songId) {
      setStatus(storage.kind === 'android' ? 'в папке нет песен — «＋ Новая песня…»' : 'нет песен в папке songs/');
      render(); return;
    }
    await document.fonts?.ready;
    await loadSong(false);
    updateUndo();
  } catch (e) {
    setStatus('ошибка: ' + e.message);
    render();
  }
})();
