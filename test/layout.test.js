import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseNote, parseRow } from '../src/notation.js';
import { songMetrics, layoutBlock, ARROW_W, REPS_W } from '../src/layout.js';

// Простой измеритель: 0.5 кегля на символ (в браузере — настоящие ширины шрифта)
const measure = (text, size) => text.length * 0.5 * size;
const song = JSON.parse(readFileSync(new URL('../songs/call-out-my-name.json', import.meta.url), 'utf8'));

test('нота: русское название, октава, удержание', () => {
  assert.deepEqual(parseNote('Ab0'), { en: 'Ab', ru: 'Ляb', oct: '0', hold: null, pitch: 8 });
  assert.deepEqual(parseNote('C#3'), { en: 'C#', ru: 'До#', oct: '3', hold: null, pitch: 37 });
  assert.equal(parseNote('Eb2~').hold, 'end');
  assert.equal(parseNote('Bb1~9').hold, 9);
  assert.equal(parseNote('H2'), null);
});

test('строка: аккорд, стопка, пустой столбец, ошибки', () => {
  const r = parseRow('[Ab0 Ab1] > Gb1 > _ > {Bb1 Eb2~}');
  assert.equal(r.cols.length, 4);
  assert.equal(r.cols[0].chord, true);
  assert.equal(r.cols[0].notes.length, 2);
  assert.equal(r.cols[2], null);
  assert.equal(r.cols[3].chord, false);
  assert.deepEqual(parseRow('').cols, []);
  assert.equal(parseRow('Ab1 > Zz').errors.length, 1);
});

test('все блоки песни — одной ширины, столбец чётный (центр на точке)', () => {
  const m = songMetrics(song, measure);
  assert.equal(m.colW % 2, 0);
  const widths = song.blocks.map(b => layoutBlock(b, m, measure).w);
  assert.ok(widths.every(w => w === m.width));
  assert.equal(m.width, 1 + m.maxCols * m.colW + (m.maxCols - 1) * ARROW_W + 1 + REPS_W);
});

test('всё в целых клетках: рамка, стрелки, скобки, удержания', () => {
  const m = songMetrics(song, measure);
  for (const b of song.blocks) {
    const lay = layoutBlock(b, m, measure);
    assert.deepEqual(lay.errors, []);
    for (const it of lay.items) {
      if (it.type === 'arrow') assert.ok(Number.isInteger(it.x), 'стрелка начинается на точке');
      if (it.type === 'line' && (it.y0 === it.y1)) {        // горизонтальные линии
        assert.ok(Number.isInteger(it.x1), 'линия кончается на точке');
      }
    }
  }
});

test('блок 2: удержание правой руки до 9-го столбца с чертой', () => {
  const m = songMetrics(song, measure);
  const lay = layoutBlock(song.blocks[1], m, measure);
  const bar = 1 + 8 * (m.colW + ARROW_W) - ARROW_W;          // правый край 8-го столбца
  assert.ok(lay.items.some(it => it.type === 'line' && it.x0 === bar && it.x1 === bar), 'вертикальная черта');
  const arrows = lay.items.filter(it => it.type === 'arrow');
  assert.equal(arrows.length, 8);                               // 9 столбцов левой руки → 8 стрелок, у правой — нет
});
