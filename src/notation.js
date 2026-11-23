// Запись нот в блоке — одна строка на руку:
//   Ab1            нота (буква, b или #, октава) — показывается как «Ляb₁ (Ab₁)»
//   >  или  →      переход к следующему столбцу (рисуется стрелка)
//   [Ab0 Ab1]      аккорд «взять вместе» — стопка со скобкой
//   {Bb1 B1 Eb2}   стопка без скобки (например, аккорд правой руки)
//   Eb2~           нота держится до конца строки (линия удержания)
//   Bb1~9          держится до 9-го столбца (счёт с 1): перед ним вертикальная черта
//   _              пустой столбец (чтобы поставить ноты под нужными нотами другой руки)
// Пример: "[Ab0 Ab1] > Gb1 > Eb1"   "{Bb1 B1~ Eb2}"

export const RU = { C: 'До', D: 'Ре', E: 'Ми', F: 'Фа', G: 'Соль', A: 'Ля', B: 'Си' };

const NOTE_RE = /^([A-Ga-g])([#b♭♯]?)(-?\d)(?:~(\d+)?)?$/;

/** Нота: { en: 'Ab', ru: 'Ляb', oct: '0', hold: null | 'end' | номер столбца (с 1) } */
export function parseNote(token) {
  const m = NOTE_RE.exec(token.trim());
  if (!m) return null;
  const letter = m[1].toUpperCase();
  const acc = m[2] === '♭' ? 'b' : m[2] === '♯' ? '#' : m[2];
  const hold = token.includes('~') ? (m[4] ? Number(m[4]) : 'end') : null;
  return { en: letter + acc, ru: RU[letter] + acc, oct: m[3], hold };
}

/** Строка руки → массив столбцов: null (пусто) или { notes: [...], chord: bool } */
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
      const n = parseNote(tok);
      if (n) notes.push(n);
      else errors.push(`столбец ${i + 1}: не понял «${tok}» (пример: Ab1, C#3, Eb2~)`);
    }
    cols.push(notes.length ? { notes, chord } : null);
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
