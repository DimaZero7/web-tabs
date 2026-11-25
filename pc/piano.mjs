import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { isIPv4 } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const dir = join(process.env.LOCALAPPDATA || homedir(), 'web-tabs');
const file = join(dir, 'piano.json');
const bundled = join(dir, 'midi-env', 'Scripts', 'python.exe');
const python = process.env.WEBTABS_PYTHON || (existsSync(bundled) ? bundled : 'python');
const script = fileURLToPath(new URL('./tablet_midi.py', import.meta.url));
const options = { windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } };
const run = promisify(execFile);
const supported = process.platform === 'win32';
let settings = {}, worker = null;
let status = { state: 'idle', message: 'Укажите планшет и MIDI-вход.' };

function start() {
  if (!worker) {
    const child = spawn(python, [script, '--serve'], { ...options, stdio: ['pipe', 'pipe', 'ignore'] });
    worker = child;
    const fail = () => {
      if (worker !== child) return;
      worker = null;
      status = { state: 'error', message: 'Передатчик остановлен. Проверьте Python и пакет python-rtmidi, затем нажмите «Подключить».' };
    };
    child.on('error', fail);
    child.on('close', fail);
    child.stdin.on('error', fail);
    createInterface({ input: child.stdout }).on('line', line => {
      if (worker === child) {
        try { status = JSON.parse(line); } catch { /* ignore non-status output */ }
      }
    });
  }
  status = { state: 'waiting', message: 'Подключаюсь к планшету…' };
  worker.stdin.write(JSON.stringify(settings) + '\n');
}

export function autoConnect() {
  if (!supported) return;
  try {
    settings = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    if (settings.pin && settings.port) start();
  } catch (err) {
    if (err.code !== 'ENOENT') status = { state: 'error', message: 'Не удалось прочитать настройки подключения.' };
  }
}

export function pianoStatus() {
  const { host = '', alternate = '', port = '', usb = false } = settings;
  return { supported, ...status, host, alternate, port, usb, hasPin: Boolean(settings.pin) };
}

export async function midiPorts() {
  const { stdout } = await run(python, [script, '--ports'], { ...options, timeout: 5000 });
  return JSON.parse(stdout);
}

export function configure(input) {
  const { host = '', alternate = '', usb = false, port = '' } = input;
  const pin = input.pin || settings.pin;
  if (typeof usb !== 'boolean' || typeof port !== 'string' || !port.trim() ||
      typeof pin !== 'string' || !/^\d{6}$/.test(pin) ||
      typeof host !== 'string' || typeof alternate !== 'string' ||
      (!usb && !isIPv4(host)) || (alternate && !isIPv4(alternate))) {
    throw new Error('Проверьте IP планшета, шестизначный код и MIDI-вход.');
  }
  const next = { host, alternate, usb, port, pin };
  mkdirSync(dir, { recursive: true });
  const temp = file + '.' + process.pid + '.tmp';
  writeFileSync(temp, JSON.stringify(next), { mode: 0o600 });
  renameSync(temp, file);
  settings = next;
  start();
}
