import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sequence, practiceSteps, Trainer, noteName, MIDI_OFFSET } from '../src/practice.js';

const song = JSON.parse(readFileSync(new URL('../songs/call-out-my-name.json', import.meta.url), 'utf8'));
const [b1, b2, b3, b4] = song.blocks;
const stepsOf = blocks => practiceSteps(sequence(blocks));
const play = (tr, notes) => notes.map(n => tr.press(n).kind);

test('октавы: запись + 36 = клавиша пианино (сверено на Yamaha 25.11.2026)', () => {
  assert.equal(MIDI_OFFSET, 36);
  assert.equal(noteName(44), 'Ab0');           // Ab2 на пианино
  assert.equal(noteName(63), 'Eb2');           // Eb4
  assert.equal(noteName(60), 'C2');            // средняя «до»
  assert.equal(noteName(34), 'Bb-1');
});

test('шаги блока 1: аккорд обеих рук, левая ×2 под одну правую', () => {
  const s = stepsOf([b1]);
  assert.equal(s.length, 12);
  assert.deepEqual([...s[0].pitches].sort(), [44, 56, 58, 59, 63]);
  assert.deepEqual([...s[1].pitches], [54]);
  assert.deepEqual([...s[6].pitches].sort(), [44, 56]);   // второй повтор левой
});

test('песня целиком: блоки идут подряд, шаг знает свой блок', () => {
  const seq = sequence([b1, b2, b3, b4]);
  assert.deepEqual(seq.segments.map(x => x.offset), [0, 12, 21, 30]);
  assert.equal(seq.total, 45);
  const s = practiceSteps(seq);
  const first3 = s.find(x => x.seg === 2);
  assert.equal(first3.local, 0);
  assert.deepEqual([...first3.pitches].sort(), [51, 70]);
});

// Нажатия, записанные с пианино 25.11.2026 (только «нажата», по порядку)
const REC_B1 = [58, 44, 63, 56, 59, 54, 51, 56, 54, 51, 44, 56, 54, 51, 56, 54, 51];
const REC_B3 = [51, 70, 73, 54, 56, 75, 70, 63, 56, 46, 54, 68];

test('записанный блок 1 — чистый проход', () => {
  const tr = new Trainer(stepsOf([b1]), { n: 3, kind: 'clean' });
  const kinds = play(tr, REC_B1);
  assert.equal(kinds.at(-1), 'pass');
  assert.ok(!kinds.includes('wrong'));
  assert.deepEqual(tr.stats, { passes: 1, clean: 1, streak: 1, best: 1 });
});

test('записанный блок 3 — Bb0 вместо Ab0 в 4-м шаге: ошибка, шаг ждёт', () => {
  const tr = new Trainer(stepsOf([b3]), { n: 1, kind: 'passes' });
  const kinds = play(tr, REC_B3);
  assert.equal(kinds[9], 'wrong');
  assert.equal(tr.cur, 3);                     // всё ещё 4-й шаг
  assert.deepEqual(tr.errors[0], { step: 3, played: 46 });
  assert.equal(tr.press(44).kind, 'step');     // правильная Ab0 — шаг пройден
});

test('порядок внутри шага не важен, повторное нажатие той же ноты — не ошибка', () => {
  const tr = new Trainer(stepsOf([b1]), { n: 1, kind: 'clean' });
  assert.deepEqual(play(tr, [63, 63, 44, 59, 58]), ['ok', 'again', 'ok', 'ok', 'ok']);
  assert.equal(tr.press(56).kind, 'step');
});

test('счётчики: чистые подряд сбрасываются ошибкой, цель «N чистых подряд»', () => {
  const tr = new Trainer(stepsOf([b1]), { n: 2, kind: 'clean' });
  play(tr, REC_B1);                                       // чистый
  play(tr, [99, ...REC_B1]);                              // с ошибкой
  assert.deepEqual(tr.stats, { passes: 2, clean: 1, streak: 0, best: 1 });
  assert.equal(tr.history[1].errors.length, 1);
  play(tr, REC_B1);
  const last = play(tr, REC_B1).at(-1);
  assert.equal(last, 'done');
  assert.deepEqual(tr.stats, { passes: 4, clean: 3, streak: 2, best: 2 });
  assert.equal(tr.press(58).kind, 'idle');                // после цели нажатия не считаются
});

test('цель «N проходов» считает и проходы с ошибками; restart не засчитывает проход', () => {
  const tr = new Trainer(stepsOf([b1]), { n: 2, kind: 'passes' });
  play(tr, [58, 44, 99]);
  tr.restart();
  assert.equal(tr.cur, 0);
  assert.equal(tr.errors.length, 0);
  assert.equal(play(tr, [1, ...REC_B1]).at(-1), 'pass');
  assert.equal(play(tr, REC_B1).at(-1), 'done');
  assert.deepEqual(tr.stats, { passes: 2, clean: 1, streak: 1, best: 1 });
});
