// Где хранятся песни. Два варианта с одним набором действий:
//  • компьютер — локальный сервер serve.mjs, файлы songs/*.json;
//  • планшет (Android-приложение) — файлы на Google Диске (или где угодно), выбранные
//    через системное окно Android; читает и пишет их приложение, Диск синхронизирует сам.
//
// Действия: list() → [{ id, title }], read(id) → песня, write(id, song) → mtime, mtime(id) → число,
//           и только на Android: open() / create(title) → { id, title } (выбор/создание файла), forget(id).

async function api(path, opts) {
  const r = await fetch(path, opts);
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
  return r.json();
}

const serverStorage = {
  kind: 'server',
  list: () => api('/api/songs'),
  read: id => api(`/api/songs/${encodeURIComponent(id)}`),
  write: async (id, song) => (await api(`/api/songs/${encodeURIComponent(id)}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(song),
  })).mtime,
  mtime: async id => (await api(`/api/songs/${encodeURIComponent(id)}/mtime`)).mtime,
};

// Мост к Android: window.WebTabsAndroid (Java, addJavascriptInterface). Методы моста синхронные
// и возвращают строку JSON; выбор файла — асинхронный, ответ приходит в window.__androidResult.
function androidStorage(bridge) {
  const call = (name, ...args) => {
    const res = JSON.parse(bridge[name](...args));
    if (res.error) throw new Error(res.error);
    return res;
  };
  const pending = new Map();
  let seq = 0;
  window.__androidResult = (reqId, json) => {
    const p = pending.get(reqId); pending.delete(reqId);
    const res = JSON.parse(json);
    if (!p) return;
    if (res.error) p.reject(new Error(res.error)); else p.resolve(res);
  };
  const ask = (name, ...args) => new Promise((resolve, reject) => {
    const reqId = String(++seq);
    pending.set(reqId, { resolve, reject });
    bridge[name](reqId, ...args);
  });
  return {
    kind: 'android',
    list: async () => call('list').songs,
    read: async id => JSON.parse(call('read', id).text),
    write: async (id, song) => call('write', id, JSON.stringify(song, null, 2)).mtime,
    mtime: async id => call('mtime', id).mtime,
    open: () => ask('open'),
    create: title => ask('create', title),
    forget: async id => call('forget', id),
  };
}

export const storage = window.WebTabsAndroid ? androidStorage(window.WebTabsAndroid) : serverStorage;

/** Пустая песня для нового файла */
export const emptySong = title => ({
  title,
  blocks: [{ id: 'b1', x: 1, y: 1, left: '', right: '', reps: [1, 1] }],
});
