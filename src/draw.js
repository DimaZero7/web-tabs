// Отрисовка на canvas: сетка точек как в MyScript Notes и элементы блоков.
import { SIZE, SUB } from './layout.js';
import { noteParts } from './notation.js';

export const BG = '#000000';        // фон доски (замер в MyScript: 0, 0, 0)
export const DOT = '#515151';       // точки (замер: 81, 81, 81)
export const INK = '#ffffff';
export const FONT = '"Segoe UI", Roboto, Arial, sans-serif';

/** Точки сетки. cam: { x, y — клетка в левом верхнем углу экрана, z — пикселей на клетку } */
export function drawGrid(ctx, cam, w, h, dpr) {
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, w, h);
  // В MyScript точки почти одного размера при любом масштабе (~0,45 мм); слегка подрастают с масштабом
  const r = Math.min(1.7, Math.max(0.75, cam.z * 0.035)) * dpr;
  const z = cam.z * dpr;
  if (z < 4) return;                                  // совсем мелко — точки сливаются, не рисуем
  ctx.fillStyle = DOT;
  const x0 = Math.ceil(cam.x), y0 = Math.ceil(cam.y);
  for (let gx = x0; (gx - cam.x) * z <= w; gx++) {
    const sx = (gx - cam.x) * z;
    for (let gy = y0; (gy - cam.y) * z <= h; gy++) {
      ctx.beginPath();
      ctx.arc(sx, (gy - cam.y) * z, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

/** Элементы блока (из layoutBlock) с левым верхним углом в (ox, oy) пикселей, z — пикселей на клетку */
export function drawItems(ctx, items, ox, oy, z, ink = INK) {
  const X = u => ox + u * z, Y = u => oy + u * z;
  ctx.strokeStyle = ink;
  ctx.fillStyle = ink;
  ctx.lineCap = 'round';
  ctx.textBaseline = 'alphabetic';
  for (const it of items) {
    if (it.type === 'line') {
      ctx.lineWidth = Math.max(1, it.w * z);
      ctx.beginPath(); ctx.moveTo(X(it.x0), Y(it.y0)); ctx.lineTo(X(it.x1), Y(it.y1)); ctx.stroke();
    } else if (it.type === 'arrow') {                 // стрелка ровно в одну клетку
      const a = X(it.x + 0.14), b = X(it.x + 0.86), y = Y(it.y), hh = 0.12 * z;
      ctx.lineWidth = Math.max(1, 0.045 * z);
      ctx.beginPath();
      ctx.moveTo(a, y); ctx.lineTo(b, y);
      ctx.moveTo(b - hh * 1.3, y - hh); ctx.lineTo(b, y); ctx.lineTo(b - hh * 1.3, y + hh);
      ctx.stroke();
    } else if (it.type === 'note') {
      let x = X(it.x);
      const base = Y(it.cy + SIZE * 0.36);
      for (const p of noteParts(it.note)) {
        ctx.font = `${p.sub ? 400 : 500} ${SIZE * (p.sub ? SUB : 1) * z}px ${FONT}`;
        ctx.fillText(p.t, x, base + (p.sub ? 0.12 * z : 0));
        x += ctx.measureText(p.t).width;
      }
    } else if (it.type === 'num') {
      ctx.font = `500 ${SIZE * 1.15 * z}px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.fillText(it.text, X(it.cx), Y(it.cy + SIZE * 1.15 * 0.36));
      ctx.textAlign = 'left';
    }
  }
}

/** Измеритель текста для раскладки: ширина в клетках при кегле size клеток */
export function makeMeasure() {
  const c = document.createElement('canvas').getContext('2d');
  const cache = new Map();
  return (text, size, sub) => {
    const key = text + '|' + size + '|' + sub;
    if (!cache.has(key)) {
      c.font = `${sub ? 400 : 500} 100px ${FONT}`;
      cache.set(key, (c.measureText(text).width / 100) * size);
    }
    return cache.get(key);
  };
}
