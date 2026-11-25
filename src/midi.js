// Пианино по кабелю: Web MIDI (Chrome, Edge на компьютере). Слушаем все входы MIDI сразу —
// подключили пианино на ходу, переткнули кабель — подхватывается само.
// Доступ спрашивается один раз за страницу; входы открыты, только пока есть подписчики
// (закрыли тренировку — пианино свободно для других программ).
//
// listenMidi({ onNote(midi, velocity), onOff(midi), onStatus({ state, names }) }) → функция «отписаться»
//   state: 'unsupported' — браузер не умеет MIDI (встроенный браузер Android-приложения);
//          'asking' — браузер спрашивает разрешение; 'denied' — доступ не дали (retryMidi() — спросить снова);
//          'none' — доступ есть, пианино не подключено; 'ready' — есть входы.
//
// Одна клавиша — одно нажатие: если пианино шлёт ноту дважды (второй канал в режиме Dual,
// два порта), onNote приходит только при первом нажатии, onOff — когда отпущены все копии.
//
// Для проверки без пианино: window.__wtMidi.on(44) / .off(44) — как нажатие на клавишу.

const subs = new Set();
let access = null, asking = null, status = { state: 'none', names: [] };
const down = new Map();                    // клавиша → сколько копий сейчас нажато

const emit = (kind, ...args) => { for (const s of subs) s[kind]?.(...args); };
const setStatus = st => { status = st; emit('onStatus', st); };

function noteOn(n, v) {
  const c = down.get(n) || 0;
  down.set(n, c + 1);
  if (c === 0) emit('onNote', n, v);
}
function noteOff(n) {
  const c = down.get(n) || 0;
  if (c <= 1) { if (down.delete(n)) emit('onOff', n); } else down.set(n, c - 1);
}
function releaseAll() { for (const n of [...down.keys()]) { down.delete(n); emit('onOff', n); } }

function onMessage(e) {
  const [st, a, b] = e.data;
  const kind = st & 0xf0;
  if (kind === 0x90 && b > 0) noteOn(a, b);
  else if (kind === 0x80 || (kind === 0x90 && b === 0)) noteOff(a);
}

function bind() {
  if (!access) return;
  const names = [];
  let lost = false;
  for (const input of access.inputs.values()) {
    if (input.state === 'disconnected') { lost = true; input.onmidimessage = null; continue; }
    if (subs.size) { input.onmidimessage = onMessage; names.push(input.name || 'MIDI'); }
  }
  if (lost) releaseAll();                  // выдернули кабель с зажатой клавишей — не держать её
  if (subs.size) setStatus({ state: names.length ? 'ready' : 'none', names });
}

// Подписчиков нет — закрыть входы (на Windows вход MIDI может держать только одна программа)
function unbind() {
  if (!access) return;
  for (const input of access.inputs.values()) {
    input.onmidimessage = null;
    input.close?.().catch?.(() => {});
  }
  down.clear();
}

async function ask() {
  if (!navigator.requestMIDIAccess || window.WebTabsAndroid) return setStatus({ state: 'unsupported', names: [] });
  setStatus({ state: 'asking', names: [] });
  try {
    access = await navigator.requestMIDIAccess({ sysex: false });
    access.onstatechange = bind;
    bind();
  } catch {
    setStatus({ state: 'denied', names: [] });
  } finally {
    asking = null;
  }
}

/** Спросить доступ ещё раз (после «не дали») */
export function retryMidi() { if (!access && !asking) asking = ask(); }

export function listenMidi(sub) {
  if (window.WebTabsAndroid?.startPiano) return listenTablet(sub);
  subs.add(sub);
  if (access) bind();                      // входы могли быть закрыты — открыть снова
  else if (!asking) asking = ask();
  sub.onStatus?.(status);
  return () => { subs.delete(sub); if (!subs.size) unbind(); };
}

let sessionNumber = 0;
function listenTablet(sub) {
  let session = '';
  subs.add(sub);
  function stop() {
    session = '';
    window.WebTabsAndroid.stopPianoInput();
    releaseAll();
  }
  function connect() {
    if (document.hidden) { stop(); return; }
    session = String(++sessionNumber);
    window.__wtRemoteMidi = (id, kind, key, detail) => {
      if (id !== session) return;
      if (kind === 'on') noteOn(key, Number(detail));
      else if (kind === 'off') noteOff(key);
      else if (kind === 'reset') releaseAll();
      else {
        if (kind !== 'ready') releaseAll();
        sub.onStatus?.({ state: kind === 'ready' ? 'ready' : 'remote', names: [], detail });
      }
    };
    sub.onStatus?.({ state: 'remote', names: [], detail: 'Подключаю пианино по Wi-Fi…' });
    window.WebTabsAndroid.startPiano(session);
  }
  connect();
  document.addEventListener('visibilitychange', connect);
  return () => {
    document.removeEventListener('visibilitychange', connect);
    stop();
    subs.delete(sub);
    delete window.__wtRemoteMidi;
  };
}

export const midiAvailable = () => window.WebTabsAndroid
  ? !!window.WebTabsAndroid.startPiano : !!navigator.requestMIDIAccess;

window.__wtMidi = { on: (n, v = 64) => noteOn(n, v), off: n => noteOff(n) };
