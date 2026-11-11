#!/usr/bin/env bash
# Headless frontend performance gate for Spotlight in an isolated GNOME Shell.
#
# The daemon is started directly with `gjs -m searchd/main.js` when possible;
# no systemd --user manager is required. tests/headless/perf.js stops it via
# the daemon's own Quit() method to prove the offline fallback in the same
# session. The gate also works when the daemon cannot start at all (fallback
# only) instead of failing on the environment.
#
# Exit codes:
#   0  PASS marker printed by tests/headless/perf.js
#   1  perf ran but failed its thresholds
#   3  environment cannot run the perf test (SKIP: <reason>)
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UUID="spotlight@haniewicz.dev"
TIMEOUT="${SPOTLIGHT_PERF_TIMEOUT:-180}"

skip() {
  printf 'SKIP: %s\n' "$*"
  exit 3
}

for program in gnome-shell dbus-run-session glib-compile-schemas; do
  command -v "$program" >/dev/null 2>&1 || skip "brak $program w PATH"
done

shell_typelib_dirs=()
for dir in /usr/lib64/gnome-shell /usr/lib/gnome-shell; do
  if compgen -G "$dir/St-*.typelib" >/dev/null; then
    shell_typelib_dirs+=("$dir")
    break
  fi
done

mutter_typelib_dirs=()
for dir in /usr/lib64/mutter-* /usr/lib/mutter-*; do
  if [ -d "$dir" ] && compgen -G "$dir/Meta-*.typelib" >/dev/null; then
    mutter_typelib_dirs+=("$dir")
  fi
done

if [ "${#shell_typelib_dirs[@]}" -eq 0 ]; then
  skip "nie można ustawić GI_TYPELIB_PATH (brak katalogu z St-*.typelib)"
fi
if [ "${#mutter_typelib_dirs[@]}" -eq 0 ]; then
  skip "nie można ustawić GI_TYPELIB_PATH (brak katalogu z Meta-*.typelib)"
fi

GI_TYPELIB_PATH="$(IFS=:; printf '%s' "${shell_typelib_dirs[*]}:${mutter_typelib_dirs[*]}")${GI_TYPELIB_PATH:+:$GI_TYPELIB_PATH}"
export GI_TYPELIB_PATH

TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/spotlight-perf.XXXXXX")" ||
  skip "nie można utworzyć katalogu tymczasowego"

cleanup() {
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT

export XDG_DATA_HOME="$TMP_ROOT/data"
export XDG_CONFIG_HOME="$TMP_ROOT/config"
export XDG_CACHE_HOME="$TMP_ROOT/cache"
export XDG_RUNTIME_DIR="$TMP_ROOT/runtime"
export GSETTINGS_BACKEND=memory

mkdir -p "$XDG_DATA_HOME/gnome-shell/extensions/$UUID" \
  "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"

DEST="$XDG_DATA_HOME/gnome-shell/extensions/$UUID"
cp "$ROOT/extension.js" "$ROOT/prefs.js" "$ROOT/metadata.json" "$ROOT/stylesheet.css" "$DEST/"
cp -R "$ROOT/lib" "$ROOT/schemas" "$DEST/"

if ! glib-compile-schemas --strict "$DEST/schemas" >/dev/null 2>&1; then
  printf 'FAIL: nie można skompilować schematu w izolowanym katalogu rozszerzenia\n'
  exit 1
fi

LOG="$TMP_ROOT/perf.log"
DAEMON_LOG="$TMP_ROOT/daemon.log"

(
  cd "$ROOT" || exit 1
  timeout "$TIMEOUT" dbus-run-session -- bash -c '
    set -u
    ROOT_DIR="$1"
    DAEMON_LOG="$2"
    cd "$ROOT_DIR" || exit 1

    daemon_pid=""
    cleanup_daemon() {
      if [ -n "$daemon_pid" ]; then
        kill "$daemon_pid" 2>/dev/null || true
        wait "$daemon_pid" 2>/dev/null || true
        daemon_pid=""
      fi
    }
    trap cleanup_daemon EXIT
    trap 'cleanup_daemon; exit 143' TERM INT

    # No systemctl --user dependency: launch the daemon directly in this
    # isolated session. If a service already owns the name, the new process
    # exits immediately and the existing daemon stays the only owner.
    if command -v gjs >/dev/null 2>&1; then
      gjs -m searchd/main.js >"$DAEMON_LOG" 2>&1 &
      daemon_pid=$!
    fi

    ready=0
    for _ in $(seq 1 100); do
      if busctl --user call org.freedesktop.DBus /org/freedesktop/DBus \
          org.freedesktop.DBus NameHasOwner s org.gnome.Spotlight \
          2>/dev/null | grep -q true; then
        ready=1
        break
      fi
      if [ -n "$daemon_pid" ] && ! kill -0 "$daemon_pid" 2>/dev/null; then
        break
      fi
      sleep 0.05
    done

    if [ "$ready" -ne 1 ]; then
      printf "INFO: daemon niedostępny; bramka mierzy fallback lokalny\n" >&2
    fi

    gnome-shell --headless \
      --virtual-monitor=1280x720 \
      --wayland \
      --no-x11 \
      --automation-script=tests/headless/perf.js
    rc=$?

    cleanup_daemon
    exit "$rc"
  ' bash "$ROOT" "$DAEMON_LOG"
) >"$LOG" 2>&1
rc=$?

cat "$LOG"

if [ "$rc" -eq 124 ]; then
  printf 'FAIL: perf przekroczył limit %ss\n' "$TIMEOUT"
  exit 1
fi

if [ "$rc" -ne 0 ]; then
  printf 'FAIL: gnome-shell zakończył perf z kodem %s\n' "$rc"
  [ -s "$DAEMON_LOG" ] && { printf '%s\n' '--- daemon log ---'; cat "$DAEMON_LOG"; }
  exit 1
fi

if grep -Fq 'FAIL:' "$LOG"; then
  printf 'FAIL: skrypt perf zgłosił błąd\n'
  exit 1
fi

if ! grep -Fxq 'PASS: frontend first-paint<=16ms result<=30ms stall<=50ms fallback<=120ms' "$LOG"; then
  printf 'FAIL: brak znacznika PASS: frontend first-paint<=16ms result<=30ms stall<=50ms fallback<=120ms\n'
  [ -s "$DAEMON_LOG" ] && { printf '%s\n' '--- daemon log ---'; cat "$DAEMON_LOG"; }
  exit 1
fi

exit 0