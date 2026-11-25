"""Send a Windows MIDI input to web-tabs over the home network."""
import ctypes
import ipaddress
import json
import os
import queue
import shutil
import socket
import subprocess
import threading
import time
import tkinter as tk
from pathlib import Path
from tkinter import ttk

import rtmidi

CONFIG = Path(os.environ.get("LOCALAPPDATA", Path.home())) / "web-tabs" / "piano.json"
TITLE = "web-tabs · Пианино на планшете"


def read_settings():
    try:
        return json.loads(CONFIG.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError):
        return {}


def handshake(sock, pin):
    sock.sendall(f"WTM1:{pin}\n".encode("ascii"))
    with sock.makefile("rb", buffering=0) as response:
        ack = response.readline(3)
        if not ack:
            raise ConnectionError("Планшет закрыл соединение")
        if ack != b"OK\n":
            raise ValueError("Планшет отклонил код")


def send_keys(sock, midi):
    """Drain the current input in order, including note-on with zero velocity (release)."""
    message = midi.get_message()
    while message:
        data, _ = message
        if len(data) == 3 and data[0] & 0xf0 in (0x80, 0x90):
            sock.sendall(bytes((data[0] & 0xf0, data[1], data[2])))
        message = midi.get_message()


def forward(sock, port_name, stop, report):
    midi = rtmidi.MidiIn(queue_size_limit=2048)
    next_check = 0
    try:
        while not stop.is_set():
            now = time.monotonic()
            if now >= next_check:
                ports = midi.get_ports()
                if port_name not in ports:
                    if midi.is_port_open():
                        midi.close_port()
                    sock.sendall(bytes((0, 0, 0)))
                    report(f"Планшет подключён. Жду вход {port_name}.")
                elif not midi.is_port_open():
                    try:
                        midi.open_port(ports.index(port_name))
                    except rtmidi.RtMidiError:
                        sock.sendall(bytes((0, 0, 0)))
                        report("Вход MIDI занят. Закройте другую тренировку на ПК.")
                    else:
                        sock.sendall(bytes((1, 0, 0)))
                        report(f"{port_name} → планшет. Можно играть.")
                else:
                    sock.sendall(bytes((2, 0, 0)))
                next_check = now + 1
            if midi.is_port_open():
                send_keys(sock, midi)
            stop.wait(0.004 if midi.is_port_open() else 0.25)
    finally:
        midi.close_port()


def usb_forward():
    sdk = Path(os.environ.get("ANDROID_SDK") or Path.home() / "Documents/AndroidEmulator/sdk")
    adb = shutil.which("adb") or str(sdk / "platform-tools/adb.exe")
    if not Path(adb).exists():
        return None
    options = dict(capture_output=True, text=True, timeout=4, creationflags=subprocess.CREATE_NO_WINDOW)
    try:
        devices = subprocess.run([adb, "devices", "-l"], **options).stdout.splitlines()
        rows = (line.split() for line in devices)
        physical = [row[0] for row in rows if len(row) >= 2 and row[1] == "device"
                    and ":" not in row[0] and not row[0].startswith("emulator-")]
        if len(physical) != 1:
            return None
        command = [adb, "-s", physical[0], "forward"]
        port = subprocess.run(command + ["tcp:0", "tcp:5179"], **options).stdout.strip()
        if port.isdigit():
            return int(port), lambda: subprocess.run(command + ["--remove", f"tcp:{port}"], **options)
    except (OSError, subprocess.TimeoutExpired):
        pass
    return None


def relay(addresses, pin, port_name, stop, report):
    def session(host, port, route):
        with socket.create_connection((host, port), timeout=1.5) as sock:
            sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            handshake(sock, pin)
            forward(sock, port_name, stop, lambda text: report(f"{route} · {text}"))

    while not stop.is_set():
        try:
            for host in addresses:
                if stop.is_set():
                    return
                try:
                    session(host, 5179, host)
                    break
                except OSError:
                    pass
            if not addresses:
                usb = usb_forward()
                if usb:
                    port, release = usb
                    try:
                        session("127.0.0.1", port, "USB")
                    finally:
                        release()
            if not stop.is_set():
                report("Жду тренировку на планшете…")
        except ValueError as error:
            report(str(error))
        except (OSError, subprocess.TimeoutExpired):
            report("Жду тренировку на планшете…")
        except rtmidi.RtMidiError as error:
            report(f"Ошибка MIDI: {error}")
        stop.wait(1)


def main():
    # Opening the desktop shortcut twice should bring the existing sender forward.
    mutex = ctypes.windll.kernel32.CreateMutexW(None, False, "Local\\WebTabsPianoSender")
    if ctypes.windll.kernel32.GetLastError() == 183:
        handle = ctypes.windll.user32.FindWindowW(None, TITLE)
        if handle:
            ctypes.windll.user32.ShowWindow(handle, 9)
            ctypes.windll.user32.SetForegroundWindow(handle)
        return

    root = tk.Tk()
    root.title(TITLE)
    panel = ttk.Frame(root, padding=16)
    panel.pack(fill="both", expand=True)
    settings = read_settings()
    host = tk.StringVar(value=settings.get("host", ""))
    alternate = tk.StringVar(value=settings.get("alternate", ""))
    usb_only = tk.BooleanVar(value=settings.get("usb", False))
    pin = tk.StringVar(value=settings.get("pin", ""))
    port = tk.StringVar(value=settings.get("port", ""))
    status = tk.StringVar(value="Откройте тренировку на планшете. Там появятся адрес и код.")
    for row, (label, field) in enumerate([("IP планшета", host), ("Запасной IP", alternate), ("Код с планшета", pin)]):
        ttk.Label(panel, text=label).grid(row=row, column=0, sticky="w", pady=3)
        ttk.Entry(panel, textvariable=field).grid(row=row, column=1, sticky="ew", padx=8)
    ttk.Label(panel, text="Вход MIDI").grid(row=3, column=0, sticky="w")
    ports = ttk.Combobox(panel, textvariable=port, state="readonly", width=30)
    ports.grid(row=3, column=1, padx=8, sticky="ew")

    def refresh():
        names = rtmidi.MidiIn().get_ports()
        ports["values"] = names
        if not port.get() and names:
            port.set(next((n for n in names if "piano" in n.lower()), names[0]))

    ports.configure(postcommand=refresh)
    refresh()
    panel.columnconfigure(1, weight=1)
    ttk.Label(panel, textvariable=status, wraplength=390).grid(row=4, columnspan=2, sticky="w", pady=10)
    stop = threading.Event()
    messages = queue.SimpleQueue()
    worker = None

    def connect():
        nonlocal stop, worker, messages
        try:
            addresses = [] if usb_only.get() else [
                str(ipaddress.IPv4Address(v.get().strip())) for v in (host, alternate) if v.get().strip()]
            if not addresses and not usb_only.get():
                raise ValueError()
            code = pin.get().strip()
            if len(code) != 6 or not code.isascii() or not code.isdigit() or not port.get():
                raise ValueError()
        except ValueError:
            status.set("Укажите IPv4-адрес, шестизначный код и вход MIDI.")
            return
        if worker and worker.is_alive():
            stop.set()
        CONFIG.parent.mkdir(parents=True, exist_ok=True)
        CONFIG.write_text(json.dumps(dict(host=host.get().strip(), alternate=alternate.get().strip(),
                                         pin=code, port=port.get(), usb=usb_only.get())), encoding="utf-8")
        stop = threading.Event()
        messages = queue.SimpleQueue()
        status.set("Подключение…")
        worker = threading.Thread(target=relay, args=(addresses, code, port.get(), stop, messages.put), daemon=True)
        worker.start()

    def poll():
        while not messages.empty():
            status.set(messages.get())
        root.after(150, poll)

    ttk.Checkbutton(panel, text="По USB", variable=usb_only).grid(row=5, column=0, sticky="w")
    ttk.Button(panel, text="Подключить", command=connect).grid(row=5, column=1, sticky="e", padx=8)
    if settings:
        connect()
    poll()
    root.mainloop()
    stop.set()
    ctypes.windll.kernel32.CloseHandle(mutex)


if __name__ == "__main__":
    main()
