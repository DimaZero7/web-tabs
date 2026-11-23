// Режим «на пианино»: блок сверху (текущий шаг подсвечен), падающие ноты
// (левая рука — синяя, правая — зелёная) и клавиатура с нажатыми клавишами.
import { blockTimeline, columnAt } from './timeline.js';
import { songMetrics, layoutBlock, ARROW_W } from './layout.js';
import { drawItems, FONT } from './draw.js';
import { RU, parseRow } from './notation.js';
import { ICON } from './icons.js';

const BG = '#08080a';
const HAND = {
  L: { base: '#5b8eff', light: '#a3c0ff', deep: '#2f5fd2', rgb: '91,142,255' },
  R: { base: '#3fd68b', light: '#94f1c1', deep: '#1c9a5d', rgb: '63,214,139' },
};
const OCT = '255,84,84';                                  // линии и номера октав
const WHITE_OF = { 0: 'C', 2: 'D', 4: 'E', 5: 'F', 7: 'G', 9: 'A', 11: 'B' };
const LOOKAHEAD = 4;                                      // сколько шагов вперёд видно падающими
const SPEEDS = [0.5, 1, 1.5, 2];

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const load = (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
const save = (k, v) => { try { localStorage.setItem(k, String(v)); } catch { /* приватный режим */ } };

let current = null;                                       // открытый проигрыватель (один на страницу)

export function openPlayer({ song, block, measure }) {
  current?.close();
  const $ = id => document.getElementById(id);
  const root = $('player'), canvas = $('pl-canvas'), ctx = canvas.getContext('2d');
  const ui = {
    title: $('pl-title'), step: $('pl-step'), play: $('pl-play'), loop: $('pl-loop'),
    sound: $('pl-sound'), speed: $('pl-speed'), progress: $('pl-progress'),
  };
  const { events, total } = blockTimeline(block);
  const metrics = songMetrics(song, measure);
  const lay = layoutBlock(block, metrics, measure);
  const n = song.blocks.indexOf(block) + 1;
  // граница рук в блоке (в клетках) — как в layoutBlock
  const rowsOf = { L: parseRow(block.left).cols, R: parseRow(block.right).cols };
  const HT = Math.max(1, ...parseRow(block.left).cols.map(c => (c ? c.notes.length : 0))) + 2;

  // диапазон клавиатуры: целые октавы от самой низкой ноты до самой высокой (не меньше трёх)
  const pitches = events.map(e => e.pitch);
  let lo = Math.floor(Math.min(...pitches, 24) / 12), hi = Math.floor(Math.max(...pitches, 24) / 12);
  while (hi - lo < 2) { if (lo > -1) lo--; else hi++; if (hi - lo < 2) hi++; }
  const keys = [];                                       // { pitch, white, x, w } в долях белой клавиши
  let wi = 0;
  for (let p = lo * 12; p < (hi + 1) * 12; p++) {
    const s = ((p % 12) + 12) % 12;
    if (s in WHITE_OF) keys.push({ pitch: p, white: true, x: wi++, w: 1, name: WHITE_OF[s] });
    else keys.push({ pitch: p, white: false, x: wi - 0.3, w: 0.6 });
  }
  const whiteCount = wi;
  const byPitch = new Map(keys.map(k => [k.pitch, k]));
  const whites = keys.filter(k => k.white), blacks = keys.filter(k => !k.white);
  const fallOrder = [...events].sort((a, b) => (byPitch.get(a.pitch)?.white ? 0 : 1) - (byPitch.get(b.pitch)?.white ? 0 : 1));

  // ---------- состояние ----------
  const saved = Number(load('wt-speed', 1)) || 1;
  const st = {
    t: 0, playing: false, last: 0, raf: 0,
    speed: SPEEDS.reduce((a, b) => (Math.abs(b - saved) < Math.abs(a - saved) ? b : a)),
    loop: load('wt-loop', '1') !== '0',
    sound: load('wt-sound', '0') === '1',
  };
  const shown = { step: -1, playing: null };             // что сейчас показано в панели

  // ---------- обработчики (все снимаются при закрытии) ----------
  const offs = [];
  const on = (el, type, fn, opt) => { el.addEventListener(type, fn, opt); offs.push(() => el.removeEventListener(type, fn, opt)); };

  // ---------- звук (простой синтез) ----------
  let audio = null, master = null;
  const voices = new Map();
  // октава записи на 1 меньше, чем в видео; «C3» видео — средняя «до» (MIDI 60) → MIDI = pitch + 36
  const freq = p => 440 * Math.pow(2, (p + 36 - 69) / 12);
  function ensureAudio() {
    if (!audio) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      audio = new AC();
      const comp = audio.createDynamicsCompressor();      // чтобы аккорды не хрипели
      master = audio.createGain(); master.gain.value = 0.9;
      master.connect(comp).connect(audio.destination);
    }
    if (audio.state === 'suspended') audio.resume();
    return audio;
  }
  function voice(pitch, oneShot) {
    const t0 = audio.currentTime;
    const o = audio.createOscillator(), g = audio.createGain();
    o.type = 'triangle'; o.frequency.value = freq(pitch);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.16, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(oneShot ? 0.0001 : 0.05, t0 + (oneShot ? 1.6 : 0.7));
    o.connect(g); g.connect(master); o.start(t0);
    if (oneShot) o.stop(t0 + 1.7);
    let done = false;
    return {
      stop() {
        if (done) return; done = true;
        try {
          const t = audio.currentTime;
          if (g.gain.cancelAndHoldAtTime) g.gain.cancelAndHoldAtTime(t);
          else { g.gain.cancelScheduledValues(t); g.gain.setValueAtTime(g.gain.value, t); }
          g.gain.setTargetAtTime(0.0001, t, 0.05);
          o.stop(t + 0.35);
        } catch { /* уже остановлен */ }
      },
    };
  }
  const stopAll = () => { for (const v of voices.values()) v.stop(); voices.clear(); };
  const activeAt = t => events.reduce((s, e, i) => (t >= e.start && t < e.end ? s.add(i) : s), new Set());
  // во время игры: звучат ровно те ноты, что сейчас нажаты
  function sound(t) {
    if (!st.sound || !ensureAudio()) return;
    const active = activeAt(t);
    for (const [id, v] of voices) if (!active.has(id)) { v.stop(); voices.delete(id); }
    for (const i of active) if (!voices.has(i)) voices.set(i, voice(events[i].pitch, false));
  }
  // на паузе (шаг, переход): коротко проиграть текущий шаг
  function preview() {
    stopAll();
    if (!st.sound || !ensureAudio()) return;
    for (const i of activeAt(st.t)) voices.set('p' + i, voice(events[i].pitch, true));
  }

  // ---------- панель ----------
  ui.title.textContent = `${song.title || 'Песня'} · Блок ${n}`;
  for (const id of ['start', 'prev', 'next', 'close']) $('pl-' + id).innerHTML = ICON[id];
  ui.loop.innerHTML = ICON.loop;
  const setLoop = () => { ui.loop.classList.toggle('on', st.loop); ui.loop.setAttribute('aria-pressed', st.loop); };
  const setSound = () => {
    ui.sound.innerHTML = st.sound ? ICON.sound : ICON.mute;
    ui.sound.classList.toggle('on', st.sound); ui.sound.setAttribute('aria-pressed', st.sound);
    ui.sound.title = st.sound ? 'Звук включён' : 'Звук выключен';
  };
  const setSpeed = () => {
    for (const b of ui.speed.querySelectorAll('button[data-speed]')) b.classList.toggle('on', Number(b.dataset.speed) === st.speed);
  };
  setLoop(); setSound(); setSpeed();

  // полоса шагов: по кнопке на шаг
  const steps = [];
  ui.progress.replaceChildren();
  for (let i = 0; i < total; i++) {
    const b = document.createElement('button');
    b.type = 'button'; b.title = `Шаг ${i + 1}`; b.dataset.step = i;
    steps.push(b); ui.progress.append(b);
  }

  // обновить панель — только когда сменился шаг или пуск/пауза
  function syncUI() {
    const s = clamp(Math.floor(st.t), 0, total - 1);
    if (s !== shown.step) {
      steps.forEach((b, i) => { b.classList.toggle('done', i < s); b.classList.toggle('now', i === s); });
      const at = columnAt(block, s), parts = [`шаг ${s + 1} / ${total}`];
      if (at.L?.reps > 1) parts.push(`левая: повтор ${at.L.rep} / ${at.L.reps}`);
      if (at.R?.reps > 1) parts.push(`правая: повтор ${at.R.rep} / ${at.R.reps}`);
      ui.step.textContent = parts.join(' · ');
      shown.step = s;
    }
    if (st.playing !== shown.playing) {
      ui.play.innerHTML = st.playing ? ICON.pause : ICON.play;
      ui.play.setAttribute('aria-label', st.playing ? 'Пауза' : 'Пуск');
      shown.playing = st.playing;
    }
  }

  root.hidden = false;

  // ---------- отрисовка ----------
  function draw() {
    const dpr = window.devicePixelRatio || 1;
    const W = canvas.clientWidth, H = canvas.clientHeight;
    if (!W || !H) return;
    const PW = Math.round(W * dpr), PH = Math.round(H * dpr);
    if (canvas.width !== PW || canvas.height !== PH) { canvas.width = PW; canvas.height = PH; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);               // дальше всё в CSS-пикселях
    ctx.fillStyle = BG; ctx.fillRect(0, 0, W, H);
    const t = st.t;
    const pad = clamp(W * 0.016, 12, 28);

    // геометрия: клавиатура снизу, блок сверху, между ними — падающие ноты
    const kw = (W - 2 * pad) / whiteCount;
    const kh = clamp(Math.min(kw * 4.8, H * 0.24), 44, 230);
    const kx = pad, ky = H - pad - kh;                    // ky — верх клавиш (линия удара)
    const X = k => kx + k.x * kw;
    // масштаб блока — от высоты окна, а не от высоты блока: кегль не скачет между блоками
    // и не опускается ниже ~13 px, пока зоне падения остаётся хоть какое-то место
    const by = pad + 2, strip = 24;                       // strip — полоса номеров октав над зоной падения
    const laneMin = Math.max(80, H * 0.2);
    const zPref = clamp(H * 0.04, 22, 32), zCap = (ky - by - strip - laneMin) / lay.h;
    const z = Math.max(4, Math.min((W - 2 * pad) / lay.w, zPref, zCap));
    const bw = lay.w * z, bh = lay.h * z, bx = (W - bw) / 2;
    const laneTop = by + bh + strip, laneBot = ky - 3, laneH = laneBot - laneTop;
    const perStep = laneH / LOOKAHEAD;

    // 1) блок: текущие столбцы — мягкая подсветка цветом руки; удерживаемые ноты — слабее
    const at = columnAt(block, Math.min(t, total - 0.001));
    const colX = i => 1 + i * (metrics.colW + ARROW_W);
    // удерживаемые — только те строки стопки, что реально звучат: [столбец, строка]
    const held = { L: [], R: [] };
    for (const e of events) {
      if (!(t >= e.start && t < e.end) || at[e.hand]?.col === e.col) continue;
      const row = rowsOf[e.hand][e.col]?.notes.findIndex(n => n && n.pitch === e.pitch) ?? -1;
      if (row >= 0) held[e.hand].push([e.col, row]);
    }
    for (const [hand, top, bottom] of [['L', 0, HT], ['R', HT, lay.h]]) {
      ctx.fillStyle = `rgba(${HAND[hand].rgb},0.14)`;
      for (const [col, row] of held[hand]) {
        rr(ctx, bx + (colX(col) - 0.35) * z, by + (top + 1 + row + 0.04) * z, (metrics.colW + 0.7) * z, 0.92 * z, Math.min(8, z * 0.35));
        ctx.fill();
      }
      if (at[hand]) {
        const col = at[hand].col;
        ctx.fillStyle = `rgba(${HAND[hand].rgb},0.18)`;
        rr(ctx, bx + (colX(col) - 0.35) * z, by + (top + 0.2) * z, (metrics.colW + 0.7) * z, (bottom - top - 0.4) * z, Math.min(10, z * 0.5));
        ctx.fill();
      }
    }
    ctx.textAlign = 'left';                               // drawItems рассчитывает на выравнивание влево
    drawItems(ctx, lay.items, bx, by, z,'rgba(232,232,238,0.92)');

    // 2) зона падения
    const pressed = new Map();                            // pitch → рука
    for (const e of events) if (t >= e.start && t < e.end) pressed.set(e.pitch, e.hand);
    if (laneH > 20) {
      ctx.save();
      ctx.beginPath(); ctx.rect(kx, laneTop, W - 2 * pad, laneH); ctx.clip();
      // еле заметные направляющие: шаги по горизонтали, Ми|Фа по вертикали, Си|До — красным
      ctx.fillStyle = 'rgba(255,255,255,0.035)';
      for (let s = Math.ceil(t); s <= t + LOOKAHEAD; s++) ctx.fillRect(kx, Math.round(laneBot - (s - t) * perStep), W - 2 * pad, 1);
      for (let o = lo; o <= hi; o++) ctx.fillRect(X(byPitch.get(o * 12 + 5)) - 0.5, laneTop, 1, laneH);

      // падающие ноты: яркая «голова» (первый шаг) и спокойное полупрозрачное тело удержания.
      // Ширина у всех одна (полклавиши минус зазор) — соседние ноты не слипаются.
      const nw = Math.max(4, kw * 0.5 - 2), r = Math.min(nw * 0.3, 7), bodyW = nw * 0.6;
      // подпись — одно правило для всех нот: полная («Gb2»), иначе без октавы («Gb»), иначе никакой
      ctx.font = `600 10px ${FONT}`;
      const refFull = ctx.measureText('Gb2').width / 10, refShort = ctx.measureText('Gb').width / 10;
      let lfs = Math.min(13, (nw - 4) / refFull), shortLabel = false;
      if (lfs < 11) { lfs = Math.min(13, (nw - 4) / refShort); shortLabel = true; }   // кегль не меньше 11 px
      const headH = perStep - 4;
      const labels = lfs >= 11 && headH >= lfs + 8;       // все подписи одного шага — на одной линии
      ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
      for (const e of fallOrder) {                        // сначала белые, поверх — чёрные
        if (e.end <= t || e.start >= t + LOOKAHEAD) continue;
        const k = byPitch.get(e.pitch); if (!k) continue;
        const c = HAND[e.hand], active = e.start <= t, cx = X(k) + k.w * kw / 2, x = cx - nw / 2;
        const yEnd = laneBot - (e.end - t) * perStep + 2;          // верх ноты
        const yHead = laneBot - (e.start + 1 - t) * perStep + 2;   // верх головы
        const hBot = Math.min(laneBot - (e.start - t) * perStep - 2, laneBot);
        const headOn = yHead < laneBot - 1;               // голова ещё не ушла за линию удара
        // тело удержания: без свечения, вверх растворяется
        if (e.end - e.start > 1) {
          const bTop = Math.max(yEnd, laneTop), bBot = headOn ? yHead + r : laneBot;
          if (bBot - bTop > 1) {
            const g = ctx.createLinearGradient(0, bTop, 0, bBot);
            g.addColorStop(0, `rgba(${c.rgb},${yEnd < laneTop ? 0 : 0.34})`);
            g.addColorStop(Math.min(1, 90 / (bBot - bTop)), `rgba(${c.rgb},0.5)`);
            g.addColorStop(1, `rgba(${c.rgb},${headOn ? 0.55 : 0.72})`);
            ctx.fillStyle = g; rr(ctx, cx - bodyW / 2, bTop, bodyW, bBot - bTop, bodyW * 0.5); ctx.fill();
          }
        }
        if (headOn && hBot - yHead > 2) {
          const g = ctx.createLinearGradient(0, yHead, 0, hBot);
          g.addColorStop(0, c.base); g.addColorStop(1, c.light);
          ctx.shadowColor = `rgba(${c.rgb},${active ? 0.65 : 0.4})`; ctx.shadowBlur = (active ? 14 : 8) * dpr;
          ctx.fillStyle = g; rr(ctx, x, yHead, nw, hBot - yHead, r); ctx.fill();
          ctx.shadowBlur = 0; ctx.shadowColor = 'transparent';
          ctx.strokeStyle = 'rgba(255,255,255,0.28)'; ctx.lineWidth = 1;
          rr(ctx, x + 0.5, yHead + 0.5, nw - 1, hBot - yHead - 1, r); ctx.stroke();
        }
        if (labels) {
          // тёмная на светлой голове, светлая — на теле удержания у линии удара
          const ly = hBot - 6;
          const onHead = headOn && ly - lfs >= yHead + 1;
          if (onHead || (active && e.end - e.start > 1)) {
            ctx.font = `600 ${lfs}px ${FONT}`;
            ctx.fillStyle = onHead ? 'rgba(4,8,18,0.9)' : 'rgba(255,255,255,0.88)';
            ctx.fillText(shortLabel ? e.note.en : e.note.en + e.note.oct, cx, ly);
          }
        }
      }

      // мягкое появление сверху
      const fade = Math.min(64, laneH * 0.3), fg = ctx.createLinearGradient(0, laneTop, 0, laneTop + fade);
      fg.addColorStop(0, 'rgba(8,8,10,1)'); fg.addColorStop(1, 'rgba(8,8,10,0)');
      ctx.fillStyle = fg; ctx.fillRect(kx, laneTop, W - 2 * pad, fade);
      ctx.restore();
    }
    // границы октав (Си|До) — поверх нот; номера — в своей полосе над зоной падения, где нот нет
    ctx.font = `600 11px ${FONT}`; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    for (let o = lo; o <= hi; o++) {
      const x = X(byPitch.get(o * 12));
      if (o > lo && laneH > 0) { ctx.fillStyle = `rgba(${OCT},0.4)`; ctx.fillRect(x - 0.5, laneTop - 16, 1, laneH + 16); }
      ctx.fillStyle = 'rgba(255,138,138,0.9)';
      ctx.fillText(String(o), x + 5, laneTop - 6);
    }

    // свечение над нажатыми клавишами и тонкая линия удара
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    for (const [p, hand] of pressed) {
      const k = byPitch.get(p); if (!k) continue;
      const gh = Math.min(28, Math.max(0, laneH)), w = kw * 0.5, cx = X(k) + k.w * kw / 2;
      const g = ctx.createLinearGradient(0, ky - gh, 0, ky);
      g.addColorStop(0, `rgba(${HAND[hand].rgb},0)`); g.addColorStop(1, `rgba(${HAND[hand].rgb},0.16)`);
      ctx.fillStyle = g; ctx.fillRect(cx - w / 2, ky - gh, w, gh);
    }
    ctx.restore();
    const hl = ctx.createLinearGradient(kx, 0, W - pad, 0);
    hl.addColorStop(0, 'rgba(255,255,255,0)'); hl.addColorStop(0.06, 'rgba(255,255,255,0.16)');
    hl.addColorStop(0.94, 'rgba(255,255,255,0.16)'); hl.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = hl; ctx.fillRect(kx, ky - 1.5, W - 2 * pad, 1);

    // 3) клавиатура: белые (сначала ненажатые, потом нажатые со свечением), подписи, чёрные
    const gap = kw >= 28 ? 2 : 1, wr = clamp(kw * 0.12, 2, 6), lip = clamp(kh * 0.035, 3, 7);
    for (const pass of [false, true]) for (const k of whites) {
      const h = pressed.get(k.pitch);
      if (!!h !== pass) continue;
      const x = X(k) + gap / 2, w = kw - gap, g = ctx.createLinearGradient(0, ky, 0, ky + kh);
      if (h) {
        const c = HAND[h];
        g.addColorStop(0, c.deep); g.addColorStop(0.3, c.base); g.addColorStop(1, c.light);
        ctx.shadowColor = `rgba(${c.rgb},0.55)`; ctx.shadowBlur = 16 * dpr;
      } else { g.addColorStop(0, '#b4b5bd'); g.addColorStop(0.07, '#d8d9df'); g.addColorStop(1, '#ececf0'); }
      ctx.fillStyle = g; rr(ctx, x, ky, w, kh, 0, wr); ctx.fill();
      ctx.shadowBlur = 0; ctx.shadowColor = 'transparent';
      ctx.fillStyle = h ? 'rgba(0,0,0,0.14)' : 'rgba(0,0,0,0.07)';       // нижняя кромка
      rr(ctx, x, ky + kh - lip, w, lip, 0, wr); ctx.fill();
    }
    // подписи на белых: сверху русская, под ней английская; только ниже чёрных клавиш
    // Правило одно, от ширины клавиши: от 30 px — русская и английская, уже — одна английская,
    // совсем узкие — без подписей. Кегль — от ширины клавиши (и не больше, чем влезает под чёрные).
    const bkh = kh * 0.62, zone = kh - bkh - lip - 8;
    const two = kw >= 30;
    const fs = Math.max(7, Math.min(clamp(kw * 0.26, 8, 13), zone / (two ? 2.3 : 1.1)));
    const enY = ky + kh - lip - 5, ruY = enY - fs * 1.3;
    ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    ctx.font = `500 ${fs}px ${FONT}`;
    const ruFs = Math.min(fs, fs * (kw - 6) / ctx.measureText('Соль').width);
    const showRu = two, showEn = kw >= 11;
    for (const k of whites) {
      const h = pressed.get(k.pitch), cx = X(k) + kw / 2;
      if (showRu) {
        ctx.font = `500 ${ruFs}px ${FONT}`; ctx.fillStyle = h ? 'rgba(6,10,20,0.75)' : '#6b6c75';
        ctx.fillText(RU[k.name], cx, ruY);
      }
      if (showEn) {
        ctx.font = `400 ${fs * 0.9}px ${FONT}`; ctx.fillStyle = h ? 'rgba(6,10,20,0.6)' : '#9b9ca5';
        ctx.fillText(k.name, cx, enY);
      }
    }
    // чёрные — объёмные: корпус и чуть светлее верхняя грань
    const br = clamp(kw * 0.07, 1.5, 4);
    for (const pass of [false, true]) for (const k of blacks) {
      const h = pressed.get(k.pitch);
      if (!!h !== pass) continue;
      const c = h && HAND[h], x = X(k), w = k.w * kw;
      ctx.shadowColor = h ? `rgba(${c.rgb},0.6)` : 'rgba(0,0,0,0.55)';
      ctx.shadowBlur = (h ? 16 : 5) * dpr; ctx.shadowOffsetY = h ? 0 : 2 * dpr;
      const g = ctx.createLinearGradient(0, ky, 0, ky + bkh);
      g.addColorStop(0, h ? c.deep : '#0c0c0f'); g.addColorStop(1, h ? c.base : '#1c1c21');
      ctx.fillStyle = g; rr(ctx, x, ky, w, bkh, 0, br); ctx.fill();
      ctx.shadowBlur = 0; ctx.shadowOffsetY = 0; ctx.shadowColor = 'transparent';
      const fh = bkh - Math.max(3, bkh * 0.09), g2 = ctx.createLinearGradient(0, ky, 0, ky + fh);
      g2.addColorStop(0, h ? c.base : '#141418'); g2.addColorStop(1, h ? c.light : '#34343c');
      ctx.fillStyle = g2; rr(ctx, x + w * 0.13, ky, w * 0.74, fh, 0, br * 0.8); ctx.fill();
    }
    // границы октав (Си|До) на клавиатуре
    ctx.fillStyle = `rgba(${OCT},0.6)`;
    for (let o = lo + 1; o <= hi; o++) ctx.fillRect(X(byPitch.get(o * 12)) - 0.5, ky, 1, kh);
  }

  // ---------- время ----------
  function frame(now) {
    st.raf = 0;
    if (st.playing) {
      const dt = clamp((now - st.last) / 1000, 0, 0.1); st.last = now;
      st.t += dt * st.speed;
      if (st.t >= total) {
        if (st.loop) { st.t %= total; stopAll(); }       // новый круг — ноты звучат заново
        else { st.t = total - 0.001; st.playing = false; stopAll(); }
      }
      if (st.playing) sound(st.t);
    }
    draw(); syncUI();
    if (st.playing) st.raf = requestAnimationFrame(frame);
  }
  // во время игры рисует кадр анимации, на паузе — сразу; панель обновляется сразу
  const request = () => { if (st.playing) st.raf ||= requestAnimationFrame(frame); else draw(); syncUI(); };
  const play = () => {
    if (st.t >= total - 0.01) st.t = 0;
    if (st.sound) ensureAudio();                          // внутри жеста пользователя
    stopAll(); st.playing = true; st.last = performance.now(); request();
  };
  const pause = () => { st.playing = false; stopAll(); request(); };
  const toggle = () => (st.playing ? pause() : play());
  // шаг на d: ставит паузу и коротко проигрывает новый шаг; по кругу — с конца в начало
  const step = d => {
    pause();
    const s = Math.floor(st.t + 0.001) + d;
    st.t = st.loop ? ((s % total) + total) % total : clamp(s, 0, total - 1);
    preview(); request();
  };
  // переход на шаг из полосы: игра продолжается, на паузе — коротко проигрывается
  const seek = s => {
    st.t = s;
    if (st.playing) { st.last = performance.now(); sound(st.t); } else preview();
    request();
  };

  // ---------- управление ----------
  on(window, 'keydown', e => {
    e.stopImmediatePropagation();                         // доска под проигрывателем клавиш не получает
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === ' ') { e.preventDefault(); if (!e.repeat) toggle(); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
    else if (e.key === 'Home') { e.preventDefault(); st.t = 0; pause(); }
  }, true);
  // пробел не должен ещё раз «нажать» кнопку в фокусе
  on(window, 'keyup', e => { if (e.key === ' ') { e.preventDefault(); e.stopImmediatePropagation(); } }, true);
  // кнопки не забирают фокус по клику мышью
  on(root, 'mousedown', e => { if (e.target.closest('button')) e.preventDefault(); });

  const handlers = {
    'pl-play': toggle,
    'pl-prev': () => step(-1),
    'pl-next': () => step(1),
    'pl-start': () => { st.t = 0; pause(); },
    'pl-loop': () => { st.loop = !st.loop; save('wt-loop', st.loop ? 1 : 0); setLoop(); },
    'pl-sound': () => {
      st.sound = !st.sound; save('wt-sound', st.sound ? 1 : 0); setSound();
      if (!st.sound) stopAll(); else if (st.playing) sound(st.t); else preview();
    },
    'pl-close': () => close(),
  };
  for (const [id, fn] of Object.entries(handlers)) on($(id), 'click', fn);
  on(ui.speed, 'click', e => {
    const b = e.target.closest('button[data-speed]'); if (!b) return;
    st.speed = Number(b.dataset.speed); save('wt-speed', st.speed); setSpeed();
  });
  on(ui.progress, 'click', e => {
    const b = e.target.closest('button[data-step]'); if (b) seek(Number(b.dataset.step));
  });
  // клик по холсту: левая половина — шаг назад, правая — вперёд
  on(canvas, 'click', e => {
    const r = canvas.getBoundingClientRect();
    step(e.clientX - r.left > r.width / 2 ? 1 : -1);
  });
  let ro = null;
  // размер окна сменился — перерисовать сразу, не дожидаясь кадра
  if (window.ResizeObserver) { ro = new ResizeObserver(() => draw()); ro.observe(canvas); }
  on(window, 'resize', () => draw());

  let closed = false;
  function close() {
    if (closed) return; closed = true;
    st.playing = false;
    if (st.raf) cancelAnimationFrame(st.raf); st.raf = 0;
    stopAll();
    if (audio) audio.close().catch(() => {});
    ro?.disconnect();
    for (const off of offs) off();
    root.hidden = true;
    if (current === api) current = null;
  }

  const api = { close };
  current = api;
  syncUI(); draw();
  return api;
}

/** Прямоугольник со скруглением: rt — верхние углы, rb — нижние */
function rr(ctx, x, y, w, h, rt, rb = rt) {
  ctx.beginPath();
  if (w <= 0 || h <= 0) return;
  rt = Math.max(0, Math.min(rt, w / 2, h / 2)); rb = Math.max(0, Math.min(rb, w / 2, h / 2));
  ctx.moveTo(x + rt, y);
  ctx.lineTo(x + w - rt, y); ctx.arcTo(x + w, y, x + w, y + rt, rt);
  ctx.lineTo(x + w, y + h - rb); ctx.arcTo(x + w, y + h, x + w - rb, y + h, rb);
  ctx.lineTo(x + rb, y + h); ctx.arcTo(x, y + h, x, y + h - rb, rb);
  ctx.lineTo(x, y + rt); ctx.arcTo(x, y, x + rt, y, rt);
  ctx.closePath();
}
