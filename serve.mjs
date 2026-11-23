// Локальный сервер web-tabs: раздаёт приложение и хранит песни файлами в songs/*.json.
// Правки из браузера сохраняются в файл, правки файла (руками или Claude) — подхватываются браузером.
// Запуск: npm start  (или node serve.mjs) → http://localhost:5178
import { createServer } from 'node:http';
import { readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const SONGS = join(ROOT, 'songs');
const PORT = Number(process.env.PORT) || 5178;
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
};

const send = (res, code, body, type = 'application/json; charset=utf-8') => {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};
const songPath = id => /^[\w.-]+$/.test(id) ? join(SONGS, `${id}.json`) : null;
const readBody = req => new Promise((ok, fail) => {
  let data = ''; req.setEncoding('utf8');
  req.on('data', c => { data += c; if (data.length > 5e6) fail(new Error('слишком большой файл')); });
  req.on('end', () => ok(data)); req.on('error', fail);
});

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);

    // API песен
    if (parts[0] === 'api' && parts[1] === 'songs' && parts.length === 2) {
      const files = (await readdir(SONGS)).filter(f => f.endsWith('.json'));
      const list = await Promise.all(files.map(async f => {
        const song = JSON.parse(await readFile(join(SONGS, f), 'utf8'));
        return { id: f.slice(0, -5), title: song.title || f };
      }));
      return send(res, 200, list);
    }
    if (parts[0] === 'api' && parts[1] === 'songs' && parts.length >= 3) {
      const file = songPath(parts[2]);
      if (!file) return send(res, 400, { error: 'плохое имя песни' });
      if (parts[3] === 'mtime') return send(res, 200, { mtime: (await stat(file)).mtimeMs });
      if (req.method === 'GET') return send(res, 200, await readFile(file, 'utf8'));
      if (req.method === 'PUT') {
        const song = JSON.parse(await readBody(req));            // проверка, что это JSON
        // короткие списки чисел (повторы) — в одну строку, чтобы файл было удобно читать
        const text = JSON.stringify(song, null, 2).replace(/\[\s+(-?\d+),\s+(-?\d+)\s+\]/g, '[$1, $2]');
        await writeFile(file, text + '\n', 'utf8');
        return send(res, 200, { mtime: (await stat(file)).mtimeMs });
      }
      return send(res, 405, { error: 'метод не поддерживается' });
    }

    // Статика
    const rel = normalize(url.pathname === '/' ? '/index.html' : url.pathname).replace(/^([\\/])+/, '');
    const file = join(ROOT, rel);
    if (!file.startsWith(ROOT)) return send(res, 403, 'нельзя', 'text/plain; charset=utf-8');
    const body = await readFile(file);
    send(res, 200, body, TYPES[extname(file)] || 'application/octet-stream');
  } catch (e) {
    send(res, e.code === 'ENOENT' ? 404 : 500, { error: e.message });
  }
}).listen(PORT, '127.0.0.1', () => console.log(`web-tabs: http://localhost:${PORT}`));
