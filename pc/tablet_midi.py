"""Send a Windows MIDI input to web-tabs over the home network."""
import json
import os
import shutil
import socket
import subprocess
import threading
import time
import sys
import urllib.request
import webbrowser
from pathlib import Path

import rtmidi

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
                    report("waiting-midi", f"Планшет подключён. Жду вход {port_name}.")
                elif not midi.is_port_open():
                    try:
                        midi.open_port(ports.index(port_name))
                    except rtmidi.RtMidiError:
                        sock.sendall(bytes((0, 0, 0)))
                        report("waiting-midi", "Вход MIDI занят. Закройте другую тренировку на ПК.")
                    else:
                        sock.sendall(bytes((1, 0, 0)))
                        report("ready", f"{port_name} → планшет. Можно играть.")
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
            forward(sock, port_name, stop, lambda state, text: report(state, f"{route} · {text}"))

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
                report("waiting", "Жду тренировку на планшете…")
        except ValueError as error:
            report("error", str(error))
        except (OSError, subprocess.TimeoutExpired):
            report("waiting", "Жду тренировку на планшете…")
        except rtmidi.RtMidiError as error:
            report("error", f"Ошибка MIDI: {error}")
        stop.wait(1)


def serve():
    worker = None
    stop = threading.Event()

    def report(state, text):
        print(json.dumps({"state": state, "message": text}), flush=True)

    try:
        for line in sys.stdin:
            settings = json.loads(line)
            if worker:
                stop.set()
                worker.join()
            if not settings:
                break
            addresses = [] if settings["usb"] else [
                addr for addr in (settings["host"], settings["alternate"]) if addr]
            stop = threading.Event()
            report("waiting", "Жду тренировку на планшете…")
            worker = threading.Thread(target=relay, args=(addresses, settings["pin"], settings["port"], stop, report))
            worker.start()
    finally:
        stop.set()
        if worker:
            worker.join()


def open_app():
    # Existing Windows shortcuts point to this file. Start one local server and open its UI.
    root = Path(__file__).resolve().parents[1]
    url = "http://127.0.0.1:" + os.environ.get("PORT", "5178")
    process = None
    for _ in range(30):
        try:
            with urllib.request.urlopen(url + "/api/piano", timeout=0.5) as res:
                if "supported" in json.load(res):
                    webbrowser.open(url)
                    return
        except (OSError, ValueError):
            pass
        if process is None:
            process = subprocess.Popen(["node", str(root / "serve.mjs")], cwd=root,
                                       creationflags=subprocess.CREATE_NO_WINDOW)
        time.sleep(0.15)
    webbrowser.open(url)


if __name__ == "__main__":
    if sys.argv[1:] == ["--serve"]:
        serve()
    elif sys.argv[1:] == ["--ports"]:
        print(json.dumps(rtmidi.MidiIn().get_ports()))
    else:
        open_app()
