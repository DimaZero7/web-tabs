// Режим «на пианино»: блок сверху (текущий шаг подсвечен), падающие ноты
// (левая рука — синяя, правая — зелёная) и клавиатура с нажатыми клавишами.
// Можно взять несколько блоков подряд (или всю песню) — они идут один за другим.
// Два режима: «Смотреть» (ноты падают сами) и «Тренировка» (пианино по кабелю: ноты ждут
// у клавиатуры, пока не нажмёшь правильные клавиши; неверная — тихий сигнал; счётчики проходов).
import { columnAt } from './timeline.js';
import { songMetrics, layoutBlock, ARROW_W } from './layout.js';
import { drawItems, FONT } from './draw.js';
import { RU, parseRow } from './notation.js';
import { ICON } from './icons.js';
import { sequence, practiceSteps, Trainer, noteName, MIDI_OFFSET } from './practice.js';
import { listenMidi, retryMidi } from './midi.js';

const BG = '#08080a';
const HAND = {
  L: { base: '#5b8eff', light: '#a3c0ff', deep: '#2f5fd2', rgb: '91,142,255' },
  R: { base: '#3fd68b', light: '#94f1c1', deep: '#1c9a5d', rgb: '63,214,139' },
  X: { base: '#ff5d5d', light: '#ffb3b3', deep: '#c62f2f', rgb: '255,93,93' },   // неверная клавиша
};
const OCT = '255,84,84';                                  // линии и номера октав
const WHITE_OF = { 0: 'C', 2: 'D', 4: 'E', 5: 'F', 7: 'G', 9: 'A', 11: 'B' };
const LOOKAHEAD = 4;                                      // сколько шагов вперёд видно падающими
const SPEEDS = [0.5, 1, 1.5, 2];

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const load = (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
const save = (k, v) => { try { localStorage.setItem(k, String(v)); } catch { /* приватный режим */ } };

let current = null;                                       // открытый проигрыватель (один на страницу)

/**
 * Открыть проигрыватель. block — с какого блока (или from/to — номера блоков в песне, с 0),
 * mode: 'watch' — смотреть, 'practice' — тренировка с пианино.
 */
export function openPlayer({ song, getSong, block, from, to, measure, mode = 'watch' }) {
  current?.close();
  let closed = false;
  const $ = id => document.getElementById(id);
  const root = $('player'), canvas = $('pl-canvas'), ctx = canvas.getContext('2d');
  const ui = {
    title: $('pl-title'), step: $('pl-step'), play: $('pl-play'), loop: $('pl-loop'),
    sound: $('pl-sound'), speed: $('pl-speed'), progress: $('pl-progress'),
    mode: $('pl-mode'), from: $('pl-from'), to: $('pl-to'), practice: $('pl-practice'),
    goal: $('pl-goal'), goalKind: $('pl-goal-kind'), count: $('pl-count'), midi: $('pl-midi'),
    done: $('pl-done'), doneBody: $('pl-done-body'), again: $('pl-again'),
  };
  const practice = mode === 'practice';
  const all = song.blocks;
  const last = Math.max(0, all.length - 1);
  const a = clamp(from ?? Math.max(0, all.indexOf(block)), 0, last);
  const b = clamp(Math.max(a, to ?? a), 0, last);
  const seq = sequence(all.slice(a, b + 1));
  const { events, total } = seq;
  const metrics = songMetrics(song, measure);
  // по блоку: раскладка, строки рук, граница рук (в клетках) — как в layoutBlock
  const segs = seq.segments.map(s => {
    const rowsOf = { L: parseRow(s.block.left).cols, R: parseRow(s.block.right).cols };
    return {
      ...s, n: all.indexOf(s.block) + 1, lay: layoutBlock(s.block, metrics, measure), rowsOf,
      HT: Math.max(1, ...rowsOf.L.map(c => (c ? c.notes.length : 0))) + 2,
    };
  });
  const maxH = Math.max(...segs.map(s => s.lay.h));
  const segAt = t => { let i = 0; while (i + 1 < segs.length && t >= segs[i + 1].offset) i++; return i; };

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
    signal: load('wt-signal', '1') !== '0',               // тренировка: сигнал ошибки и конца прохода
  };
  const shown = { step: -1, playing: null };             // что сейчас показано в панели

  // ---------- тренировка ----------
  const steps = practice ? practiceSteps(seq) : [];
  const goal = { n: Math.max(1, Number(load('wt-goal', 10)) || 10), kind: load('wt-goal-kind', 'clean') };
  const tr = new Trainer(steps, goal);
  // что показывать в блоке и на полосе: в тренировке — шаг, который ждём (ноты к нему ещё доезжают)
  const viewT = () => (practice && tr.step ? tr.step.t : st.t);
  const keysDown = new Map();                            // нажатые на пианино: высота записи → 'L' | 'R' | 'X'
  const fx = { flashes: [], toast: null };              // вспышки неверных клавиш, надпись о проходе

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
  // сигналы тренировки: мягкий, но слышный «бум» вниз — неверная клавиша; два светлых тона — чистый проход
  function tone(f0, f1, t0, dur, vol) {
    const o = audio.createOscillator(), g = audio.createGain();
    o.type = 'triangle';
    o.frequency.setValueAtTime(f0, t0);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t0 + dur * 0.8);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g); g.connect(master); o.start(t0); o.stop(t0 + dur + 0.05);
  }
  let lastBeep = -1e9;
  function beep(kind) {
    if (!st.signal || !ensureAudio()) return;
    const t0 = audio.currentTime;
    if (kind === 'wrong') {
      const wall = performance.now();                     // не currentTime: он стоит, пока звук не разрешён
      if (wall - lastBeep < 250) return;                  // несколько лишних клавиш разом — один сигнал
      lastBeep = wall;
      tone(311, 207, t0, 0.24, 0.3);
    } else if (kind === 'clean') { tone(659, 659, t0, 0.3, 0.13); tone(988, 988, t0 + 0.13, 0.45, 0.13); }
    else tone(523, 523, t0, 0.3, 0.11);
  }

  // ---------- панель ----------
  const range = segs.length > 1 ? `Блоки ${segs[0].n}–${segs.at(-1).n}` : `Блок ${segs[0].n}`;
  ui.title.textContent = `${song.title || 'Песня'} · ${range}`;
  for (const id of ['start', 'prev', 'next', 'close']) $('pl-' + id).innerHTML = ICON[id];
  $('pl-start').title = practice ? 'Начать проход заново (не засчитывается)' : 'В начало';
  ui.loop.innerHTML = ICON.loop;
  root.classList.toggle('practice', practice);
  for (const btn of ui.mode.querySelectorAll('button[data-mode]')) btn.classList.toggle('on', btn.dataset.mode === mode);
  // выбор блоков: с какого по какой (все — вся песня)
  const opts = all.map((_, i) => `<option value="${i}">${i + 1}</option>`).join('');
  ui.from.innerHTML = opts; ui.to.innerHTML = opts;
  ui.from.value = String(a); ui.to.value = String(b);
  ui.practice.hidden = !practice;
  ui.done.hidden = true;
  ui.goal.value = String(goal.n); ui.goalKind.value = tr.goal.kind;
  const setLoop = () => { ui.loop.classList.toggle('on', st.loop); ui.loop.setAttribute('aria-pressed', st.loop); };
  const setSound = () => {
    const onNow = practice ? st.signal : st.sound;
    ui.sound.innerHTML = onNow ? ICON.sound : ICON.mute;
    ui.sound.classList.toggle('on', onNow); ui.sound.setAttribute('aria-pressed', onNow);
    ui.sound.title = practice ? (onNow ? 'Сигнал ошибки включён' : 'Сигнал ошибки выключен')
      : (onNow ? 'Звук включён' : 'Звук выключен');
  };
  const setSpeed = () => {
    for (const b of ui.speed.querySelectorAll('button[data-speed]')) b.classList.toggle('on', Number(b.dataset.speed) === st.speed);
  };
  setLoop(); setSound(); setSpeed();

  // полоса шагов: по кнопке на шаг
  // полоса шагов: по кнопке на шаг; начало каждого следующего блока — с отступом
  const stepBtns = [];
  ui.progress.replaceChildren();
  for (let i = 0; i < total; i++) {
    const btn = document.createElement('button');
    const sg = segs[segAt(i)];
    btn.type = 'button'; btn.title = `Блок ${sg.n}, шаг ${i - sg.offset + 1}`; btn.dataset.step = i;
    if (i > 0 && i === sg.offset) btn.classList.add('seg-start');
    stepBtns.push(btn); ui.progress.append(btn);
  }

  // обновить панель — только когда сменился шаг или пуск/пауза
  function syncUI() {
    const s = clamp(Math.floor(viewT() + 1e-6), 0, total - 1);
    if (s !== shown.step) {
      stepBtns.forEach((btn, i) => { btn.classList.toggle('done', i < s); btn.classList.toggle('now', i === s); });
      const sg = segs[segAt(s)], ls = s - sg.offset;
      const at = columnAt(sg.block, ls), parts = [];
      if (segs.length > 1) parts.push(`блок ${sg.n}`);
      parts.push(`шаг ${ls + 1} / ${sg.total}`);
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
    // блоки разной высоты: место под блок — по самому высокому, чтобы зона падения не прыгала
    const vt = viewT(), si = segAt(vt), sg = segs[si], lay = sg.lay, HT = sg.HT;
    const zPref = clamp(H * 0.04, 22, 32), zCap = (ky - by - strip - laneMin) / maxH;
    const z = Math.max(4, Math.min((W - 2 * pad) / lay.w, zPref, zCap));
    const bw = lay.w * z, bx = (W - bw) / 2;
    const laneTop = by + maxH * z + strip, laneBot = ky - 3, laneH = laneBot - laneTop;
    const perStep = laneH / LOOKAHEAD;

    // 1) блок: текущие столбцы — мягкая подсветка цветом руки; удерживаемые ноты — слабее
    const at = columnAt(sg.block, clamp(vt - sg.offset, 0, sg.total - 0.001));
    const colX = i => 1 + i * (metrics.colW + ARROW_W);
    // удерживаемые — только те строки стопки, что реально звучат: [столбец, строка]
    const held = { L: [], R: [] };
    for (const e of events) {
      if (e.seg !== si || !(vt >= e.start && vt < e.end) || at[e.hand]?.col === e.col) continue;
      const row = sg.rowsOf[e.hand][e.col]?.notes.findIndex(n => n && n.pitch === e.pitch) ?? -1;
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
    // смотреть — горят клавиши, что звучат по записи; тренировка — те, что нажаты на пианино
    const pressed = new Map();                            // pitch → рука
    if (practice) for (const [p, h] of keysDown) pressed.set(p, h);
    else for (const e of events) if (t >= e.start && t < e.end) pressed.set(e.pitch, e.hand);
    // тренировка: ноты текущего шага, которые уже нажаты, — бледнее (ждём остальные)
    const waitT = practice && tr.step && !tr.done ? tr.step.t : null;
    const gotIt = e => waitT !== null && e.start === waitT && tr.got.has(e.pitch + MIDI_OFFSET);
    const nowMs = performance.now();
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
          ctx.globalAlpha = gotIt(e) ? 0.3 : 1;
          const g = ctx.createLinearGradient(0, yHead, 0, hBot);
          g.addColorStop(0, c.base); g.addColorStop(1, c.light);
          ctx.shadowColor = `rgba(${c.rgb},${active ? 0.65 : 0.4})`; ctx.shadowBlur = (active ? 14 : 8) * dpr;
          ctx.fillStyle = g; rr(ctx, x, yHead, nw, hBot - yHead, r); ctx.fill();
          ctx.shadowBlur = 0; ctx.shadowColor = 'transparent';
          ctx.strokeStyle = 'rgba(255,255,255,0.28)'; ctx.lineWidth = 1;
          rr(ctx, x + 0.5, yHead + 0.5, nw - 1, hBot - yHead - 1, r); ctx.stroke();
          ctx.globalAlpha = 1;
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

      // тренировка: красная вспышка над неверной клавишей
      for (const f of fx.flashes) {
        const left = (f.until - nowMs) / 450, k = byPitch.get(f.pitch);
        if (left <= 0 || !k) continue;
        const w = kw * k.w, cx = X(k) + w / 2, gh = Math.min(laneH, 140);
        const g = ctx.createLinearGradient(0, laneBot - gh, 0, laneBot);
        g.addColorStop(0, `rgba(${HAND.X.rgb},0)`); g.addColorStop(1, `rgba(${HAND.X.rgb},${0.55 * left})`);
        ctx.fillStyle = g; ctx.fillRect(cx - w / 2, laneBot - gh, w, gh);
      }
      // надпись о законченном проходе — посередине зоны падения, тает
      if (fx.toast && fx.toast.until > nowMs) {
        const left = Math.min(1, (fx.toast.until - nowMs) / 600);
        const fsz = clamp(laneH * 0.12, 16, 34);
        ctx.font = `600 ${fsz}px ${FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillStyle = `rgba(${fx.toast.rgb},${0.95 * left})`;
        ctx.fillText(fx.toast.text, W / 2, laneTop + laneH * 0.42);
        ctx.textBaseline = 'alphabetic';
      }
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
    const dt = clamp((now - st.last) / 1000, 0, 0.1); st.last = now;
    let more = false;
    if (practice) {
      // ноты плавно доезжают до клавиатуры и стоят, пока шаг не собран
      const target = tr.step ? tr.step.t : st.t;
      if (Math.abs(target - st.t) > 0.002) { st.t += (target - st.t) * (1 - Math.exp(-dt * 14)); more = true; }
      else st.t = target;
      more ||= fx.flashes.some(f => f.until > now) || (fx.toast?.until ?? 0) > now;
    } else if (st.playing) {
      st.t += dt * st.speed;
      if (st.t >= total) {
        if (st.loop) { st.t %= total; stopAll(); }       // новый круг — ноты звучат заново
        else { st.t = total - 0.001; st.playing = false; stopAll(); }
      }
      if (st.playing) sound(st.t);
      more = st.playing;
    }
    draw(); syncUI();
    if (more) st.raf = requestAnimationFrame(frame);
  }
  // во время игры (и в тренировке) рисует кадрами анимации, на паузе — сразу; панель обновляется сразу
  const request = () => {
    if (practice || st.playing) {
      if (!st.raf) { st.last = performance.now(); st.raf = requestAnimationFrame(frame); }
    } else draw();
    syncUI();
  };
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
    else if (practice) {
      // тренировка: поля цели вводятся как обычно; Home — проход заново
      if (e.key === 'Home' && !e.target.closest?.('input')) { e.preventDefault(); restartPass(); }
    }
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
    'pl-start': () => { if (practice) restartPass(); else { st.t = 0; pause(); } },
    'pl-loop': () => { st.loop = !st.loop; save('wt-loop', st.loop ? 1 : 0); setLoop(); },
    'pl-sound': () => {
      if (practice) { st.signal = !st.signal; save('wt-signal', st.signal ? 1 : 0); setSound(); if (st.signal) beep('pass'); return; }
      st.sound = !st.sound; save('wt-sound', st.sound ? 1 : 0); setSound();
      if (!st.sound) stopAll(); else if (st.playing) sound(st.t); else preview();
    },
    'pl-close': () => close(),
    'pl-again': () => { tr.reset(); ui.done.hidden = true; st.t = 0; markErrors(); updateCount(); request(); },
  };
  for (const [id, fn] of Object.entries(handlers)) on($(id), 'click', fn);
  on(ui.speed, 'click', e => {
    const b = e.target.closest('button[data-speed]'); if (!b) return;
    st.speed = Number(b.dataset.speed); save('wt-speed', st.speed); setSpeed();
  });
  on(ui.progress, 'click', e => {
    if (practice) return;                                 // в тренировке шаги идут только по нажатиям
    const b = e.target.closest('button[data-step]'); if (b) seek(Number(b.dataset.step));
  });
  // клик по холсту: левая половина — шаг назад, правая — вперёд
  on(canvas, 'click', e => {
    if (practice) return;
    const r = canvas.getBoundingClientRect();
    step(e.clientX - r.left > r.width / 2 ? 1 : -1);
  });
  // режим и блоки: проигрыватель открывается заново с новым выбором (счёт тренировки — с нуля)
  // песню берём свежую (её могла заменить синхронизация), а фокус снимаем — стрелки/Home не меняют выбор
  const reopen = (m, f, t2) => { document.activeElement?.blur?.(); openPlayer({ song: getSong?.() || song, getSong, from: f, to: t2, measure, mode: m }); };
  on(ui.mode, 'click', e => {
    const btn = e.target.closest('button[data-mode]');
    if (btn && btn.dataset.mode !== mode) reopen(btn.dataset.mode, a, b);
  });
  on(ui.from, 'change', () => { const f = Number(ui.from.value); reopen(mode, f, Math.max(f, b)); });
  on(ui.to, 'change', () => { const t2 = Number(ui.to.value); reopen(mode, Math.min(a, t2), t2); });
  // цель: число и что считать; меняется на ходу, счёт не сбрасывается
  // цель уже достигнута (например, снизили число) — итог сразу
  const goalChanged = () => { updateCount(); if (!tr.done && tr.stats.passes && tr.reached) { tr.done = true; showDone(); } };
  on(ui.goal, 'change', () => {
    const v = Math.floor(Number(ui.goal.value));
    if (v >= 1) { tr.goal.n = v; save('wt-goal', v); } else ui.goal.value = String(tr.goal.n);
    goalChanged();
  });
  on(ui.goalKind, 'change', () => {
    tr.goal.kind = ui.goalKind.value; save('wt-goal-kind', tr.goal.kind); ui.goalKind.blur(); goalChanged();
  });
  on(ui.midi, 'click', () => { if (ui.midi.classList.contains('retry')) retryMidi(); });

  // ---------- тренировка: пианино ----------
  const nameOf = midi => noteName(midi);
  const plural = (n, one, few, many) => {
    const d = n % 10, h = n % 100;
    return d === 1 && h !== 11 ? one : d >= 2 && d <= 4 && (h < 12 || h > 14) ? few : many;
  };
  const errText = n => plural(n, 'ошибка', 'ошибки', 'ошибок');
  function updateCount() {
    if (!practice) return;
    const s = tr.stats, g = tr.goal, errs = tr.errors.length;
    if (!steps.length) { ui.count.textContent = 'В выбранных блоках нет нот'; return; }
    const main = g.kind === 'clean'
      ? `Чистых подряд: <b>${s.streak}</b> / ${g.n}`
      : `Проходов: <b>${s.passes}</b> / ${g.n}`;
    const rest = g.kind === 'clean'
      ? `всего проходов ${s.passes}, чистых ${s.clean}`
      : `чистых ${s.clean}, подряд ${s.streak}`;
    ui.count.innerHTML = `${main} <span class="dim">· ${rest} · сейчас:</span> ` +
      `<span class="${errs ? 'bad' : 'ok'}">${errs ? `${errs} ${errText(errs)}` : 'без ошибок'}</span>`;
  }
  // полоса шагов: где в этом проходе были ошибки
  function markErrors() {
    const bad = new Set(tr.errors.map(x => steps[x.step].t));
    stepBtns.forEach((btn, i) => btn.classList.toggle('err', bad.has(i)));
  }
  function restartPass() {
    if (tr.done) return;
    tr.restart(); st.t = 0; markErrors(); updateCount(); request();
  }
  // итог: проходы и где чаще ошибался
  function showDone() {
    const s = tr.stats, where = new Map();
    for (const p of tr.history) for (const x of p.errors) {
      const w = where.get(x.step) || { n: 0, played: new Map() };
      w.n++; w.played.set(x.played, (w.played.get(x.played) || 0) + 1);
      where.set(x.step, w);
    }
    const top = [...where].sort((p, q) => q[1].n - p[1].n).slice(0, 6).map(([i, w]) => {
      const stp = steps[i], sg = segs[stp.seg];
      const need = [...stp.pitches].sort((p, q) => p - q).map(nameOf).join(' ');
      const got = [...w.played].map(([m, c]) => nameOf(m) + (c > 1 ? ` ×${c}` : '')).join(', ');
      return `<li><b>Блок ${sg.n}, шаг ${stp.local + 1}</b> — ${w.n} ${plural(w.n, 'раз', 'раза', 'раз')} · нужно ${need} · нажимал ${got}</li>`;
    }).join('');
    const passes = tr.history.map((p, i) =>
      `<span class="${p.clean ? 'ok' : 'bad'}" title="Проход ${i + 1}">${p.clean ? '✓' : p.errors.length}</span>`).join('');
    const head = tr.goal.kind === 'clean' ? `${tr.goal.n} ${plural(tr.goal.n, 'чистый', 'чистых', 'чистых')} подряд`
      : `${tr.goal.n} ${plural(tr.goal.n, 'проход', 'прохода', 'проходов')}`;
    ui.doneBody.innerHTML = `<h2>Готово: ${head}</h2>` +
      `<p>Проходов ${s.passes} · чистых ${s.clean} · лучшая серия ${s.best}</p>` +
      `<div class="pl-passes">${passes}</div>` +
      (top ? `<h3>Где ошибался</h3><ul>${top}</ul>` : '<p class="ok">Ни одной ошибки!</p>');
    ui.done.hidden = false;
  }
  function onNote(midi) {
    if (closed) return;
    const p = midi - MIDI_OFFSET, before = tr.step;
    const r = tr.press(midi);
    const now = performance.now();
    if (r.kind === 'idle') { keysDown.set(p, 'L'); request(); return; }
    if (r.kind === 'wrong') {
      keysDown.set(p, 'X');
      fx.flashes = fx.flashes.filter(f => f.until > now);
      fx.flashes.push({ pitch: p, until: now + 450 });
      if (!byPitch.has(p)) fx.toast = { text: `Мимо: ${nameOf(midi)}`, rgb: '255,140,140', until: now + 900 };
      beep('wrong'); markErrors();
    } else {
      const ev = before.events.map(i => events[i]).find(e => e.pitch === p);
      keysDown.set(p, ev?.hand || 'L');
    }
    if (r.kind === 'pass' || r.kind === 'done') {
      st.t = 0;                                           // новый проход — сразу с начала
      const n = tr.stats.passes;
      fx.toast = r.clean
        ? { text: `Проход ${n} — чисто ✓`, rgb: '63,214,139', until: now + 1400 }
        : { text: `Проход ${n} — ${r.errors.length} ${errText(r.errors.length)}`, rgb: '255,190,90', until: now + 1400 };
      beep(r.clean ? 'clean' : 'pass');
      markErrors();
      if (r.kind === 'done') showDone();
    }
    updateCount(); request();
  }
  const offMidi = practice ? listenMidi({
    onNote,
    onOff: midi => { if (!closed) { keysDown.delete(midi - MIDI_OFFSET); request(); } },
    onStatus: s => {
      const text = s.detail || {
        ready: `🎹 ${s.names.join(', ')}`,
        none: 'Пианино не найдено — подключите кабель',
        asking: 'Разрешите доступ к MIDI в окне браузера…',
        denied: 'Нет доступа к MIDI — разрешите (значок слева от адреса) и нажмите сюда',
        unsupported: 'Этот браузер не видит пианино — нужен Chrome на компьютере',
      }[s.state];
      ui.midi.textContent = text;
      ui.midi.className = 'pl-midi ' + (s.state === 'ready' ? 'ok' : 'bad') + (s.state === 'denied' ? ' retry' : '');
    },
  }) : null;
  if (practice) {
    if (st.signal) ensureAudio();                         // звук разрешается только по жесту — открытие и есть жест
    on(root, 'pointerdown', () => { if (st.signal) ensureAudio(); });
    updateCount();
  }
  let ro = null;
  // размер окна сменился — перерисовать сразу, не дожидаясь кадра
  if (window.ResizeObserver) { ro = new ResizeObserver(() => draw()); ro.observe(canvas); }
  on(window, 'resize', () => draw());

  function close() {
    if (closed) return; closed = true;
    st.playing = false;
    if (st.raf) cancelAnimationFrame(st.raf); st.raf = 0;
    stopAll();
    offMidi?.(); keysDown.clear();
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
