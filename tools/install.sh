#!/usr/bin/env bash
# One-step developer install: pack the extension, unpack it into the user's
# extension directory, install the search daemon and verify that the Shell
# actually reports the extension as ACTIVE.
#
# This script intentionally reports failure when the UUID is not known to the
# running Shell yet; logging out and back in is then the remaining manual step.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOME_DIR="${HOME:-$(getent passwd "$(id -u)" | cut -d: -f6)}"
METADATA="$ROOT/metadata.json"

case "${1:-}" in
  '')
    ;;
  -h|--help)
    printf 'Usage: %s\n' "$0"
    exit 0
    ;;
  *)
    printf 'FAIL: nieznany argument: %s\n' "$1" >&2
    exit 2
    ;;
esac

for program in gnome-extensions unzip gjs; do
  if ! command -v "$program" >/dev/null 2>&1; then
    printf 'FAIL: brak %s w PATH\n' "$program" >&2
    exit 1
  fi
done

UUID="$(python3 - "$METADATA" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    print(json.load(handle)["uuid"])
PY
)"
DEST="$HOME_DIR/.local/share/gnome-shell/extensions/$UUID"

BUILD_DIR="$(mktemp -d "${TMPDIR:-/tmp}/spotlight-install.XXXXXX")"
cleanup() {
  rm -rf "$BUILD_DIR"
}
trap cleanup EXIT

STAGE="$BUILD_DIR/extension"
mkdir -p "$STAGE"
cp "$ROOT/extension.js" "$ROOT/prefs.js" "$ROOT/metadata.json" \
  "$ROOT/stylesheet.css" "$STAGE/"
cp -R "$ROOT/lib" "$ROOT/schemas" "$STAGE/"

printf 'INFO: pakuję rozszerzenie %s\n' "$UUID"
if ! pack_output="$(
  cd "$STAGE"
  gnome-extensions pack --force \
    --out-dir "$BUILD_DIR" \
    --schema=schemas/org.gnome.shell.extensions.spotlight.gschema.xml \
    --extra-source=lib \
    --extra-source=metadata.json \
    . 2>&1
)"; then
  printf '%s\n' "$pack_output" >&2
  printf 'FAIL: gnome-extensions pack nie powiódł się\n' >&2
  exit 1
fi
[ -n "$pack_output" ] && printf '%s\n' "$pack_output"

ZIP_FILE=""
for candidate in "$BUILD_DIR"/*.shell-extension.zip; do
  [ -f "$candidate" ] || continue
  ZIP_FILE="$candidate"
  break
done
if [ -z "$ZIP_FILE" ]; then
  printf 'FAIL: nie znaleziono spakowanego ZIP\n' >&2
  exit 1
fi

printf 'INFO: instaluję rozszerzenie w %s\n' "$DEST"
rm -rf "$DEST"
mkdir -p "$DEST"
if ! unzip -q -o "$ZIP_FILE" -d "$DEST"; then
  printf 'FAIL: nie można rozpakować rozszerzenia do %s\n' "$DEST" >&2
  exit 1
fi

if [ -f "$DEST/schemas/org.gnome.shell.extensions.spotlight.gschema.xml" ] &&
   command -v glib-compile-schemas >/dev/null 2>&1; then
  if ! glib-compile-schemas --strict "$DEST/schemas" >/dev/null 2>&1; then
    printf 'FAIL: nie można skompilować schematu rozszerzenia\n' >&2
    exit 1
  fi
fi

printf 'INFO: instaluję daemon gnome-spotlightd\n'
bash "$ROOT/tools/install-daemon.sh"

# Best effort: without a live Shell session the enable call fails, but the
# final ACTIVE check below still decides whether the installation succeeded.
if ! gnome-extensions enable "$UUID" >/dev/null 2>&1; then
  printf 'INFO: nie można jeszcze włączyć %s (brak sesji Shella?)\n' "$UUID" >&2
fi

printf 'INFO: wyloguj się i zaloguj, jeśli UUID nie jest jeszcze znany Shellowi.\n'

set +e
INFO="$(LC_ALL=C gnome-extensions info "$UUID" 2>&1)"
INFO_RC=$?
set -e
printf '%s\n' "$INFO"

if [ "$INFO_RC" -ne 0 ] ||
   ! printf '%s\n' "$INFO" | grep -Eq '(^|[[:space:]])State:[[:space:]]*ACTIVE([[:space:]]|$)'; then
  printf '%s\n' \
    "FAIL: rozszerzenie $UUID nie jest ACTIVE — wyloguj się i zaloguj ponownie, potem włącz je przez gnome-extensions enable." >&2
  exit 1
fi

printf 'OK: %s jest ACTIVE\n' "$UUID"