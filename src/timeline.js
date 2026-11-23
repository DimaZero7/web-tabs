// Последовательность нот блока во времени — для режима «на пианино».
// Время — в шагах: один столбец записи = один шаг.
//
// Как долго звучит нота:
//   • одна нота или аккорд в [скобке] — один шаг (до следующего столбца);
//   • Eb2~ — до конца блока; Bb1~9 — до 9-го столбца этой руки (в текущем повторе);
//   • в стопке {…} нота держится, пока на её строке не появится следующая нота;
//     если следующей нет — держится, как держится стопка (её ~ или ~N), иначе до конца блока.
// Повторы: рука играет свои столбцы столько раз, сколько записано в повторах; блок длится,
// пока играет более длинная рука («держать до конца» — до конца всего блока).
import { parseRow } from './notation.js';

/** События: { pitch, note, hand: 'L' | 'R', start, end, col } и длина блока в шагах */
export function blockTimeline(block) {
  const hands = [['L', parseRow(block.left).cols, block.reps?.[0] ?? 1],
                 ['R', parseRow(block.right).cols, block.reps?.[1] ?? 1]];
  const total = Math.max(1, ...hands.map(([, cols, reps]) => cols.length * Math.max(1, reps)));
  const events = [];
  for (const [hand, cols, repsRaw] of hands) {
    const reps = Math.max(1, repsRaw), n = cols.length;
    for (let r = 0; r < reps; r++) {
      const base = r * n;
      cols.forEach((c, i) => {
        if (!c) return;
        const stackHold = c.notes.find(x => x?.hold)?.hold ?? null;   // как держится стопка
        c.notes.forEach((note, k) => {
          if (!note) return;
          let end;
          // ~N — номер столбца в общей сетке блока (обеих рук), черта перед ним
          const holdTo = h => (h === 'end' ? total : Math.min(total, base + Math.max(i + 1, h - 1)));
          if (note.hold) end = holdTo(note.hold);
          else if (c.chord || c.notes.length === 1) end = base + i + 1;
          else {
            // стопка {…}: до следующей ноты на этой же строке
            let j = i + 1;
            while (j < n && !(cols[j] && cols[j].notes[k])) j++;
            end = j < n ? base + j : stackHold ? holdTo(stackHold) : total;
          }
          events.push({ pitch: note.pitch, note, hand, start: base + i, end: Math.max(end, base + i + 1), col: i });
        });
      });
    }
  }
  return { events, total };
}

/** Какой столбец каждой руки звучит в момент t (или -1, если рука уже доиграла) */
export function columnAt(block, t) {
  const res = {};
  for (const [hand, text, reps] of [['L', block.left, block.reps?.[0] ?? 1], ['R', block.right, block.reps?.[1] ?? 1]]) {
    const n = parseRow(text).cols.length;
    const step = Math.floor(t);
    res[hand] = n && step < n * Math.max(1, reps) ? { col: step % n, rep: Math.floor(step / n) + 1, reps: Math.max(1, reps) } : null;
  }
  return res;
}
