// Тренировка с настоящим пианино (MIDI): приложение ждёт правильные клавиши, время не важно.
//
// Шаг — момент, когда начинаются новые ноты (столбец записи). Чтобы пройти шаг, нужно нажать
// все его новые ноты — в любом порядке, можно по одной. Удержание не проверяется: отпустил
// раньше — не ошибка. Нажатие клавиши, которой в шаге нет, — ошибка; шаг ждёт дальше.
// Проход — все шаги выбранных блоков подряд. Чистый проход — без единой ошибки.
import { blockTimeline } from './timeline.js';

/** Номер клавиши MIDI = высота из записи + 36: «Ab0» записи — Ab2 на пианино (MIDI 44) */
export const MIDI_OFFSET = 36;

const NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
/** Клавиша MIDI → нота в записи web-tabs: 44 → «Ab0» */
export function noteName(midi) {
  const p = midi - MIDI_OFFSET;
  return NAMES[((p % 12) + 12) % 12] + Math.floor(p / 12);
}

/** Блоки подряд: общие события (время — в шагах от начала первого блока) и где какой блок */
export function sequence(blocks) {
  const segments = [], events = [];
  let offset = 0;
  blocks.forEach((block, seg) => {
    const tl = blockTimeline(block);
    segments.push({ block, offset, total: tl.total });
    for (const e of tl.events) events.push({ ...e, seg, start: e.start + offset, end: e.end + offset });
    offset += tl.total;
  });
  return { segments, events, total: Math.max(1, offset) };
}

/** Шаги для тренировки: { t, seg, local, pitches: Set(MIDI), events: [индексы событий] } */
export function practiceSteps(seq) {
  const byStart = new Map();
  seq.events.forEach((e, i) => {
    if (!byStart.has(e.start)) byStart.set(e.start, []);
    byStart.get(e.start).push(i);
  });
  return [...byStart.keys()].sort((a, b) => a - b).map(t => {
    const idx = byStart.get(t), seg = seq.events[idx[0]].seg;
    return {
      t, seg, local: t - seq.segments[seg].offset,
      pitches: new Set(idx.map(i => seq.events[i].pitch + MIDI_OFFSET)),
      events: idx,
    };
  });
}

/**
 * Счёт тренировки. goal: { n, kind: 'passes' — n проходов | 'clean' — n чистых подряд }.
 * press(midi) возвращает, что случилось: 'ok' (нота шага), 'again' (эта нота шага уже нажата),
 * 'wrong' (лишняя клавиша), 'step' (шаг собран), 'pass' (проход закончен), 'done' (цель достигнута),
 * 'idle' (цель уже достигнута — нажатия не считаются).
 */
export class Trainer {
  constructor(steps, goal) {
    this.steps = steps;
    this.goal = { n: Math.max(1, Math.floor(goal?.n) || 1), kind: goal?.kind === 'passes' ? 'passes' : 'clean' };
    this.reset();
  }
  reset() {
    this.stats = { passes: 0, clean: 0, streak: 0, best: 0 };
    this.history = [];                 // по проходу: { errors: [...] }
    this.done = false;
    this.restart();
  }
  /** Начать текущий проход заново (он не засчитывается) */
  restart() {
    this.cur = 0;
    this.got = new Set();
    this.errors = [];                  // ошибки этого прохода: { step, played }
  }
  get step() { return this.steps[this.cur]; }
  get reached() {
    return this.goal.kind === 'passes' ? this.stats.passes >= this.goal.n : this.stats.streak >= this.goal.n;
  }
  press(midi) {
    if (this.done || !this.steps.length) return { kind: 'idle' };
    const step = this.step;
    if (!step.pitches.has(midi)) {
      this.errors.push({ step: this.cur, played: midi });
      return { kind: 'wrong', midi };
    }
    if (this.got.has(midi)) return { kind: 'again', midi };
    this.got.add(midi);
    if (this.got.size < step.pitches.size) return { kind: 'ok', midi };
    // шаг собран
    this.got = new Set();
    this.cur++;
    if (this.cur < this.steps.length) return { kind: 'step', midi };
    // проход закончен
    const errors = this.errors, clean = errors.length === 0;
    this.stats.passes++;
    if (clean) { this.stats.clean++; this.stats.streak++; } else this.stats.streak = 0;
    this.stats.best = Math.max(this.stats.best, this.stats.streak);
    this.history.push({ errors, clean });
    this.restart();
    if (this.reached) { this.done = true; return { kind: 'done', midi, clean, errors }; }
    return { kind: 'pass', midi, clean, errors };
  }
}
