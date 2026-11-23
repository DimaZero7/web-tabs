// Запись нот в блоке — одна строка на руку:
//   Ab1            нота (буква, b или #, октава) — показывается как «Ляb₁ (Ab₁)»
//   >  или  →      переход к следующему столбцу (рисуется стрелка)
//   [Ab0 Ab1]      аккорд «взять вместе» — стопка со скобкой
//   {Bb1 B1 Eb2}   стопка без скобки (например, аккорд правой руки)
//                  В стопке ноты сверху вниз — от низкой к высокой: порядок наводится сам
//   {_ Ab2~}       нота на 2-й строке (_ — пустое место в стопке; тогда порядок — как написано).
//                  Так нота продолжает свою строку: {Eb2~ Bb2} > {_ Ab2~} — Bb2 → Ab2 на одной строке
//   Eb2~           нота держится до конца строки (линия удержания)
//   Bb1~9          держится до 9-го столбца (счёт с 1): перед ним вертикальная черта
//   _              пустой столбец (чтобы поставить ноты под нужными нотами другой руки)
// Пример: "[Ab0 Ab1] > Gb1 > Eb1"   "{Bb1 B1~ Eb2}"

export const RU = { C: 'До', D: 'Ре', E: 'Ми', F: 'Фа', G: 'Соль', A: 'Ля', B: 'Си' };

const NOTE_RE = /^([A-Ga-g])([#b♭♯]?)(-?\d)(?:~(\d+)?)?$/;
const SEMI = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** Нота: { en: 'Ab', ru: 'Ляb', oct: '0', hold: null | 'end' | номер столбца (с 1) } */
export function parseNote(token) {
  const m = NOTE_RE.exec(token.trim());
  if (!m) return null;
  const letter = m[1].toUpperCase();
  const acc = m[2] === '♭' ? 'b' : m[2] === '♯' ? '#' : m[2];
  const hold = token.includes('~') ? (m[4] ? Number(m[4]) : 'end') : null;
  const pitch = Number(m[3]) * 12 + SEMI[letter] + (acc === '#' ? 1 : acc === 'b' ? -1 : 0);
  return { en: letter + acc, ru: RU[letter] + acc, oct: m[3], hold, pitch };
}

/** Строка руки → массив столбцов: null (пусто) или { notes: [нота | null (пустое место)], chord: bool } */
export function parseRow(text) {
  const errors = [];
  const cols = [];
  const parts = (text || '').split(/[>→]/).map(s => s.trim());
  if (parts.length === 1 && parts[0] === '') return { cols, errors };
  parts.forEach((part, i) => {
    if (part === '' || part === '_') { cols.push(null); return; }
    let chord = false, inner = part;
    if (/^\[.*\]$/.test(part)) { chord = true; inner = part.slice(1, -1); }
    else if (/^\{.*\}$/.test(part)) { inner = part.slice(1, -1); }
    const notes = [];
    for (const tok of inner.split(/\s+/).filter(Boolean)) {
      if (tok === '_') { notes.push(null); continue; }
      const n = parseNote(tok);
      if (n) notes.push(n);
      else errors.push(`столбец ${i + 1}: не понял «${tok}» (пример: Ab1, C#3, Eb2~)`);
    }
    // стопка — сверху вниз от низкой ноты к высокой (если места не заданы явно через _)
    if (!notes.includes(null)) notes.sort((a, b) => a.pitch - b.pitch);
    cols.push(notes.some(Boolean) ? { notes, chord } : null);
  });
  return { cols, errors };
}

/** Подпись ноты для отрисовки: части текста, цифры октавы — нижним индексом */
export function noteParts(n) {
  return [
    { t: n.ru, sub: false }, { t: n.oct, sub: true },
    { t: ' (' + n.en, sub: false }, { t: n.oct, sub: true }, { t: ')', sub: false },
  ];
}
