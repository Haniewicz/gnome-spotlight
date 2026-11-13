#!/usr/bin/env python3
"""Wykonuje wyrażenie JS w działającym GNOME Shellu przez Looking Glass.

Dlaczego tak: nowy UUID rozszerzenia nie jest znany uruchomionemu Shellowi
(`gnome-extensions enable` → „nie istnieje", `InstallRemoteExtension` wymaga
extensions.gnome.org, `org.gnome.Shell.Eval` jest zablokowany). Looking Glass
(`Alt+F2` → `lg`) ma własne pole eval działające w procesie Shella, więc można
nim zarejestrować świeżo zainstalowaną kopię:

    tools/lg-eval.py 'Main.extensionManager._loadExtensions()'

Wymaga dostępu do zapisu `/dev/uinput` (użytkownik w ACL urządzenia) i włączonych
`development-tools` w `org.gnome.shell`. Wstrzykuje prawdziwe zdarzenia klawiatury,
więc w trakcie działania nie należy używać klawiatury.
"""
import fcntl
import os
import struct
import sys
import time

DEV = "/dev/uinput"
UI_SET_EVBIT = 0x40045564
UI_SET_KEYBIT = 0x40045565
UI_DEV_CREATE = 0x5501
UI_DEV_DESTROY = 0x5502
EV_SYN, EV_KEY = 0, 1

KEYS = {
    "esc": 1, "enter": 28, "space": 57, "leftalt": 56, "leftctrl": 29, "leftshift": 42,
    "f2": 60, "tab": 15,
    "1": 2, "2": 3, "3": 4, "4": 5, "5": 6, "6": 7, "7": 8, "8": 9, "9": 10, "0": 11,
    "-": 12, "=": 13, "[": 26, "]": 27, ";": 39, "'": 40, "`": 41, "\\": 43,
    ",": 51, ".": 52, "/": 53,
    "q": 16, "w": 17, "e": 18, "r": 19, "t": 20, "y": 21, "u": 22, "i": 23, "o": 24, "p": 25,
    "a": 30, "s": 31, "d": 32, "f": 33, "g": 34, "h": 35, "j": 36, "k": 37, "l": 38,
    "z": 44, "x": 45, "c": 46, "v": 47, "b": 48, "n": 49, "m": 50,
}

# znaki wymagające Shift (mapowanie na bazowy klawisz)
SHIFTED = {
    "_": "-", "(": "9", ")": "0", "{": "[", "}": "]", ":": ";", '"': "'",
    "@": "2", "#": "3", "$": "4", "%": "5", "&": "7", "*": "8", "+": "=", "!": "1",
    "?": "/", "|": "\\", "<": ",", ">": ".",
}


def open_device():
    fd = os.open(DEV, os.O_WRONLY | os.O_NONBLOCK)
    fcntl.ioctl(fd, UI_SET_EVBIT, EV_KEY)
    for code in set(KEYS.values()):
        fcntl.ioctl(fd, UI_SET_KEYBIT, code)
    setup = struct.pack("80sHHHHi", b"spotlight-lg-eval", 0x03, 0x1234, 0x5700, 1, 0)
    setup += struct.pack("64i", *([0] * 64)) * 4
    os.write(fd, setup)
    fcntl.ioctl(fd, UI_DEV_CREATE)
    return fd


def emit(fd, code, value):
    os.write(fd, struct.pack("llHHi", 0, 0, EV_KEY, code, value))
    os.write(fd, struct.pack("llHHi", 0, 0, EV_SYN, 0, 0))


def tap(fd, key, shift=False, delay=0.012):
    if shift:
        emit(fd, KEYS["leftshift"], 1)
    emit(fd, KEYS[key], 1)
    time.sleep(0.006)
    emit(fd, KEYS[key], 0)
    if shift:
        emit(fd, KEYS["leftshift"], 0)
    time.sleep(delay)


def type_text(fd, text):
    for ch in text:
        if ch == " ":
            tap(fd, "space")
        elif ch in SHIFTED:
            tap(fd, SHIFTED[ch], True)
        elif ch.isupper():
            tap(fd, ch.lower(), True)
        elif ch in KEYS:
            tap(fd, ch)
        else:
            raise SystemExit(f"nieobsługiwany znak: {ch!r}")


def combo(fd, *keys):
    for key in keys:
        emit(fd, KEYS[key], 1)
    time.sleep(0.04)
    for key in reversed(keys):
        emit(fd, KEYS[key], 0)
    time.sleep(0.08)


def main():
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    expr = sys.argv[1]
    fd = open_device()
    try:
        time.sleep(1.0)
        combo(fd, "leftalt", "f2")
        time.sleep(1.2)
        type_text(fd, "lg")
        time.sleep(0.2)
        tap(fd, "enter")
        time.sleep(2.0)
        combo(fd, "leftctrl", "a")  # historia LG podpowiada poprzednie polecenie
        time.sleep(0.15)
        type_text(fd, expr)
        time.sleep(0.3)
        tap(fd, "enter")
        time.sleep(2.5)
        tap(fd, "esc")
        time.sleep(0.4)
        print(f"LG: wysłano wyrażenie ({len(expr)} znaków)")
    finally:
        try:
            fcntl.ioctl(fd, UI_DEV_DESTROY)
        except OSError:
            pass
        os.close(fd)


if __name__ == "__main__":
    main()