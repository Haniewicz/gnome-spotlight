#!/usr/bin/env bash
# Cooperative live probe for the Spotlight launcher (optional, not gated).
#
# Injects Super+Space and the query through /dev/uinput, then samples
# org.gnome.Shell.Extensions.ListExtensions over the session bus every 100 ms.
# Prints p50/p95/max for the open and keystroke windows as:
#   LIVE: open-max=...ms keystroke-max=...ms ...
#
# The script never installs packages and never changes GNOME settings. It only
# writes synthetic key events and reads D-Bus.
#
# Exit codes:
#   0  LIVE marker printed
#   3  environment cannot run the probe (no /dev/uinput or session bus)
set -uo pipefail

UINPUT="${SPOTLIGHT_UINPUT:-/dev/uinput}"
QUERY="${SPOTLIGHT_PROBE_QUERY:-spot}"

skip() {
  printf 'SKIP: %s\n' "$*"
  exit 3
}

[ -e "$UINPUT" ] ||
  skip "brak $UINPUT (moduł uinput niedostępny lub urządzenie niewidoczne w sandboxie)"
[ -r "$UINPUT" ] && [ -w "$UINPUT" ] ||
  skip "brak prawa odczytu/zapisu do $UINPUT"

command -v python3 >/dev/null 2>&1 || skip "brak python3 w PATH"
command -v gdbus >/dev/null 2>&1 || skip "brak gdbus w PATH"

if [ -z "${DBUS_SESSION_BUS_ADDRESS:-}" ]; then
  if [ -z "${XDG_RUNTIME_DIR:-}" ] || [ ! -S "$XDG_RUNTIME_DIR/bus" ]; then
    skip "brak sesyjnego D-Bus (DBUS_SESSION_BUS_ADDRESS/XDG_RUNTIME_DIR)"
  fi
fi

exec python3 - "$UINPUT" "$QUERY" <<'PY'
import ctypes
import fcntl
import math
import os
import subprocess
import sys
import threading
import time

UINPUT = sys.argv[1]
QUERY = sys.argv[2]
LIST_CMD = [
    "gdbus", "call", "--session",
    "--dest", "org.gnome.Shell.Extensions",
    "--object-path", "/org/gnome/Shell/Extensions",
    "--method", "org.gnome.Shell.Extensions.ListExtensions",
]

UI_DEV_CREATE = 0x5501
UI_DEV_DESTROY = 0x5502
UI_SET_EVBIT = 0x40045564
UI_SET_KEYBIT = 0x40045565
EV_SYN = 0x00
EV_KEY = 0x01
KEY_LEFTMETA = 125
KEY_SPACE = 57
KEY_CODES = {
    "a": 30, "b": 48, "c": 46, "d": 32, "e": 18, "f": 33, "g": 34,
    "h": 35, "i": 23, "j": 36, "k": 37, "l": 38, "m": 50, "n": 49,
    "o": 24, "p": 25, "q": 16, "r": 19, "s": 31, "t": 20, "u": 22,
    "v": 47, "w": 17, "x": 45, "y": 21, "z": 44, " ": 57, ".": 52,
    "-": 12, "0": 11, "1": 2, "2": 3, "3": 4, "4": 5, "5": 6,
    "6": 7, "7": 8, "8": 9, "9": 10,
}


def skip(reason):
    print(f"SKIP: {reason}", flush=True)
    sys.exit(3)


class InputId(ctypes.Structure):
    _fields_ = [
        ("bustype", ctypes.c_uint16),
        ("vendor", ctypes.c_uint16),
        ("product", ctypes.c_uint16),
        ("version", ctypes.c_uint16),
    ]


class UinputUserDev(ctypes.Structure):
    _fields_ = [
        ("name", ctypes.c_char * 80),
        ("id", InputId),
        ("ff_effects_max", ctypes.c_uint32),
        ("absmax", ctypes.c_int32 * 64),
        ("absmin", ctypes.c_int32 * 64),
        ("absfuzz", ctypes.c_int32 * 64),
        ("absflat", ctypes.c_int32 * 64),
    ]


class TimeVal(ctypes.Structure):
    _fields_ = [("tv_sec", ctypes.c_long), ("tv_usec", ctypes.c_long)]


class InputEvent(ctypes.Structure):
    _fields_ = [
        ("time", TimeVal),
        ("type", ctypes.c_uint16),
        ("code", ctypes.c_uint16),
        ("value", ctypes.c_int32),
    ]


def emit(fd, event_type, code, value):
    event = InputEvent()
    event.type = event_type
    event.code = code
    event.value = value
    os.write(fd, bytes(event))


def key_event(fd, code, pressed):
    emit(fd, EV_KEY, code, 1 if pressed else 0)
    emit(fd, EV_SYN, 0, 0)


def tap(fd, code, hold=0.03):
    key_event(fd, code, True)
    time.sleep(hold)
    key_event(fd, code, False)


def sample_dbus():
    started = time.monotonic()
    try:
        result = subprocess.run(
            LIST_CMD,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=2,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if result.returncode != 0:
        return None
    return started, (time.monotonic() - started) * 1000.0


def percentile(values, fraction):
    ordered = sorted(values)
    if not ordered:
        return 0.0
    position = (len(ordered) - 1) * fraction
    low = math.floor(position)
    high = math.ceil(position)
    if low == high:
        return ordered[low]
    return ordered[low] + (ordered[high] - ordered[low]) * (position - low)


# A shell that does not own the interface would produce meaningless timings.
try:
    warmup = subprocess.run(
        LIST_CMD, capture_output=True, text=True, timeout=3
    )
except (OSError, subprocess.TimeoutExpired) as error:
    skip(f"nie można wywołać ListExtensions: {error}")

if warmup.returncode != 0:
    detail = (warmup.stderr or warmup.stdout).strip().splitlines()
    suffix = f": {detail[0]}" if detail else ""
    skip(f"org.gnome.Shell.Extensions.ListExtensions niedostępne{suffix}")

try:
    fd = os.open(UINPUT, os.O_WRONLY | os.O_NONBLOCK)
except OSError as error:
    skip(f"nie można otworzyć {UINPUT}: {error}")

created = False
try:
    try:
        fcntl.ioctl(fd, UI_SET_EVBIT, EV_KEY)
        keys = {KEY_LEFTMETA, KEY_SPACE}
        keys.update(
            KEY_CODES[character]
            for character in QUERY.lower()
            if character in KEY_CODES
        )
        for code in sorted(keys):
            fcntl.ioctl(fd, UI_SET_KEYBIT, code)

        device = UinputUserDev()
        device.name = b"spotlight-live-probe"
        device.id = InputId(0x03, 0x1209, 0x0001, 1)  # BUS_USB
        os.write(fd, bytes(device))
        fcntl.ioctl(fd, UI_DEV_CREATE)
        created = True
    except OSError as error:
        skip(f"nie można utworzyć urządzenia uinput: {error}")

    time.sleep(0.4)

    samples = []
    stop = threading.Event()

    def sampler():
        while not stop.is_set():
            sample = sample_dbus()
            if sample is not None:
                samples.append(sample)
            stop.wait(0.1)

    worker = threading.Thread(target=sampler, daemon=True)
    worker.start()
    time.sleep(0.12)

    open_started = time.monotonic()
    key_event(fd, KEY_LEFTMETA, True)
    time.sleep(0.05)
    tap(fd, KEY_SPACE, 0.06)
    time.sleep(0.04)
    key_event(fd, KEY_LEFTMETA, False)
    time.sleep(0.5)

    type_started = time.monotonic()
    for character in QUERY.lower():
        code = KEY_CODES.get(character)
        if code is not None:
            tap(fd, code)
        time.sleep(0.02)
    time.sleep(0.6)

    stop.set()
    worker.join(timeout=3)

    open_samples = [
        latency for started, latency in samples
        if open_started - 0.05 <= started <= open_started + 0.55
    ]
    key_samples = [
        latency for started, latency in samples
        if type_started - 0.05 <= started <= type_started + 0.55
    ]
    all_samples = [latency for _, latency in samples]

    if not open_samples or not key_samples:
        skip(
            "brak próbek D-Bus w oknie pomiaru "
            f"(open={len(open_samples)}, keystroke={len(key_samples)})"
        )

    print(
        f"LIVE: open-max={max(open_samples):.1f}ms "
        f"keystroke-max={max(key_samples):.1f}ms "
        f"open-p50={percentile(open_samples, 0.50):.1f}ms "
        f"open-p95={percentile(open_samples, 0.95):.1f}ms "
        f"keystroke-p50={percentile(key_samples, 0.50):.1f}ms "
        f"keystroke-p95={percentile(key_samples, 0.95):.1f}ms "
        f"p50={percentile(all_samples, 0.50):.1f}ms "
        f"p95={percentile(all_samples, 0.95):.1f}ms "
        f"samples={len(all_samples)}",
        flush=True,
    )
finally:
    if created:
        try:
            fcntl.ioctl(fd, UI_DEV_DESTROY)
        except OSError:
            pass
    os.close(fd)
PY