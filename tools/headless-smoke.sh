#!/usr/bin/env bash
# Headless smoke test for Spotlight in an isolated GNOME Shell session.
#
# Exit codes:
#   0  PASS marker printed by tests/headless/smoke.js
#   1  smoke ran but failed
#   3  environment cannot run the smoke test (SKIP: <reason>)
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UUID="spotlight@haniewicz.dev"
TIMEOUT="${SPOTLIGHT_SMOKE_TIMEOUT:-150}"

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

TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/spotlight-headless.XXXXXX")" ||
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

LOG="$TMP_ROOT/smoke.log"

(
  cd "$ROOT" || exit 1
  timeout "$TIMEOUT" dbus-run-session -- \
    gnome-shell --headless \
      --virtual-monitor=1280x720 \
      --wayland \
      --no-x11 \
      --automation-script=tests/headless/smoke.js
) >"$LOG" 2>&1
rc=$?

cat "$LOG"

if [ "$rc" -eq 124 ]; then
  printf 'FAIL: smoke przekroczył limit %ss\n' "$TIMEOUT"
  exit 1
fi

if [ "$rc" -ne 0 ]; then
  printf 'FAIL: gnome-shell zakończył smoke z kodem %s\n' "$rc"
  exit 1
fi

if grep -Fq 'does not implement StScrollable' "$LOG"; then
  printf 'FAIL: St-WARNING: St.ScrollView ma dziecko spoza StScrollable:\n'
  grep -F 'does not implement StScrollable' "$LOG"
  exit 1
fi

if ! grep -Fxq 'PASS: modal-open modal-typed modal-esc modal-closed preview-text' "$LOG"; then
  printf 'FAIL: brak znacznika PASS: modal-open modal-typed modal-esc modal-closed preview-text\n'
  exit 1
fi

exit 0