// Раскладка блока по сетке точек. Единица — клетка (5 мм, как на доске MyScript).
// Правила (как на доске): всё в целых клетках и по центру —
//   • столбец нот — COL_W клеток (чётное, центр — на точке), нота по центру столбца;
//   • между столбцами — ровно одна клетка под стрелку, от точки до точки;
//   • каждая нота стопки — в своей клетке по высоте, по центру клетки; сверху и снизу — по клетке;
//   • скобка аккорда — на правом краю столбца (на точке), стрелка идёт прямо от неё;
//   • линии удержания — от точки до точки; повторы — по центру своей ячейки;
//   • все блоки песни — одной ширины, с общими столбцами.
import { parseRow, noteParts } from './notation.js';

export const SIZE = 0.58;        // кегль, в клетках
export const SUB = 0.72;         // индекс октавы — доля кегля
export const ARROW_W = 1;        // клетка под стрелку
export const REPS_W = 2;         // столбец повторов
export const LINE = 0.045;       // толщина линий, в клетках

/** Ширина подписи ноты в клетках. measure(text, sizeInCells, isSub) → ширина в клетках. */
export function noteWidth(note, measure) {
  return noteParts(note).reduce((w, p) => w + measure(p.t, SIZE * (p.sub ? SUB : 1), p.sub), 0);
}

/** Общие размеры для всех блоков песни: ширина столбца и таблицы */
export function songMetrics(song, measure) {
  let widest = 0, maxCols = 1;
  for (const b of song.blocks) {
    for (const key of ['left', 'right']) {
      const { cols } = parseRow(b[key]);
      maxCols = Math.max(maxCols, cols.length);
      for (const c of cols) if (c) for (const n of c.notes) widest = Math.max(widest, noteWidth(n, measure));
    }
  }
  const colW = Math.max(4, 2 * Math.ceil((widest + 0.4) / 2));
  const width = 1 + maxCols * colW + (maxCols - 1) * ARROW_W + 1 + REPS_W;
  return { colW, maxCols, width };
}

/** Раскладка одного блока: { w, h, items, errors }, координаты — в клетках от левого верхнего угла */
export function layoutBlock(block, metrics, measure) {
  const { colW, width: W } = metrics;
  const colX = i => 1 + i * (colW + ARROW_W);
  const repsX = W - REPS_W;
  const L = parseRow(block.left), R = parseRow(block.right);
  const errors = [...L.errors.map(e => 'Левая рука, ' + e), ...R.errors.map(e => 'Правая рука, ' + e)];
  const stack = cols => Math.max(1, ...cols.map(c => (c ? c.notes.length : 0)));
  const HT = stack(L.cols) + 2, HB = stack(R.cols) + 2, H = HT + HB;
  const items = [];
  const line = (x0, y0, x1, y1, w = LINE) => items.push({ type: 'line', x0, y0, x1, y1, w });

  // Рамка
  line(0, 0, W, 0); line(0, HT, W, HT); line(0, H, W, H);
  line(0, 0, 0, H); line(W, 0, W, H); line(repsX, 0, repsX, H);

  const row = (cols, top, h) => {
    cols.forEach((c, i) => {
      if (!c) return;
      const cx = colX(i) + colW / 2, edge = colX(i) + colW;
      let right = 0;
      c.notes.forEach((n, k) => {
        const w = noteWidth(n, measure);
        items.push({ type: 'note', note: n, x: cx - w / 2, cy: top + 1 + k + 0.5 });
        right = Math.max(right, cx + w / 2);
        // удержание — от точки после ноты до точки перед повторами (или до черты в столбце N)
        if (n.hold) {
          const end = n.hold === 'end' ? repsX - 1 : colX(n.hold - 1) - ARROW_W;
          const from = Math.ceil(cx + noteWidth(n, measure) / 2 + 0.15);
          line(from, top + 1 + k + 0.5, end, top + 1 + k + 0.5);
          if (n.hold !== 'end') line(end, top, end, top + h, LINE * 1.1);
        }
      });
      if (c.chord) {                                   // скобка «взять вместе»
        const t = top + 1.12, b = top + 1 + c.notes.length - 0.12, hook = 0.2;
        line(edge - hook, t, edge, t); line(edge, t, edge, b); line(edge - hook, b, edge, b);
      }
      if (cols[i + 1]) items.push({ type: 'arrow', x: edge, y: top + 1.5 });   // стрелка в одну клетку
    });
  };
  row(L.cols, 0, HT);
  row(R.cols, HT, HB);

  const reps = block.reps || [1, 1];
  items.push({ type: 'num', text: String(reps[0] ?? ''), cx: repsX + REPS_W / 2, cy: HT / 2 });
  items.push({ type: 'num', text: String(reps[1] ?? ''), cx: repsX + REPS_W / 2, cy: HT + HB / 2 });
  return { w: W, h: H, items, errors };
}
