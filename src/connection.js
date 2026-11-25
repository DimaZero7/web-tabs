import { listenMidi } from './midi.js';

const dialog = document.getElementById('piano-dialog');
const form = document.getElementById('piano-settings');
const fields = form.elements;
const apply = document.getElementById('piano-apply');
const status = document.getElementById('piano-state');
const error = document.getElementById('piano-error');
const buttons = document.querySelectorAll('[data-piano-link]');
const android = !!window.WebTabsAndroid;
let stopListening;
let revision = 0;

function showStatus(state, message) {
  status.dataset.state = state;
  status.textContent = message;
  for (const btn of buttons) {
    btn.dataset.state = state;
    btn.title = message;
  }
}

async function api(path = '', options) {
  const r = await fetch('/api/piano' + path, options);
  const body = await r.json();
  if (!r.ok) throw new Error(body.error || r.statusText);
  return body;
}

function showError(message = '') {
  error.textContent = message;
  error.hidden = !message;
}

function syncFields() {
  fields.host.disabled = fields.alternate.disabled = fields.usb.checked;
  fields.host.required = !fields.usb.checked;
}

async function open() {
  dialog.showModal();
  showError();
  if (android) {
    if (!document.getElementById('player').hidden && !document.getElementById('pl-practice').hidden) {
      const midi = document.getElementById('pl-midi');
      const update = () => showStatus(midi.classList.contains('ok') ? 'ready' : 'waiting', midi.textContent);
      update();
      const observer = new MutationObserver(update);
      observer.observe(midi, { childList: true, attributes: true });
      stopListening = () => observer.disconnect();
    } else {
      stopListening = listenMidi({ onStatus: s => showStatus(s.state, s.detail) });
    }
    return;
  }
  const opened = ++revision;
  apply.disabled = true;
  try {
    const [cfg, ports] = await Promise.all([api(), api('/ports')]);
    if (revision !== opened) return;
    fields.host.value = cfg.host;
    fields.alternate.value = cfg.alternate;
    fields.usb.checked = cfg.usb;
    fields.pin.value = '';
    fields.pin.required = !cfg.hasPin;
    fields.pin.placeholder = cfg.hasPin ? 'Код сохранён' : '6 цифр';
    const names = [...new Set([...ports, cfg.port].filter(Boolean))];
    fields.port.replaceChildren(...names.map(name => new Option(name, name)));
    fields.port.value = cfg.port || names.find(name => /piano/i.test(name)) || names[0] || '';
    if (!names.length) showError('Подключите пианино к ПК и снова откройте настройки.');
    syncFields();
    apply.disabled = !names.length;
  } catch (e) { if (revision === opened) showError(e.message); }
}

async function refresh() {
  if (document.hidden) return;
  try {
    const cfg = await api();
    for (const btn of buttons) btn.hidden = !cfg.supported;
    showStatus(cfg.state, cfg.message);
  } catch { showStatus('error', 'Нет связи с локальным сервером web-tabs.'); }
}

for (const btn of buttons) {
  btn.onclick = open;
  if (android) btn.hidden = !window.WebTabsAndroid.startPiano;
}
if (!android) {
  document.getElementById('piano-fields').hidden = apply.hidden = false;
  refresh();
  setInterval(refresh, 2000);
}
fields.usb.onchange = syncFields;
document.getElementById('piano-close').onclick = () => dialog.close();
dialog.addEventListener('keydown', e => e.stopPropagation());
dialog.addEventListener('close', () => {
  revision++;
  stopListening?.();
  stopListening = null;
  if (android) showStatus('idle', 'Подключение пианино');
});
form.onsubmit = async e => {
  e.preventDefault();
  if (android) return;
  apply.disabled = true;
  showError();
  try {
    const cfg = await api('', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ host: fields.host.value.trim(), alternate: fields.alternate.value.trim(),
        usb: fields.usb.checked, port: fields.port.value, pin: fields.pin.value.trim() }) });
    fields.pin.value = '';
    fields.pin.placeholder = 'Код сохранён';
    fields.pin.required = false;
    showStatus(cfg.state, cfg.message);
  } catch (err) { showError(err.message); }
  finally { apply.disabled = false; }
};
