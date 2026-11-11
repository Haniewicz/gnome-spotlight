#!/usr/bin/env bash
# Package, install and activate the Spotlight GNOME Shell extension.
#
# Usage: tools/deploy.sh [--uuid-suffix X]
#
# The script only reports success when `gnome-extensions info` reports
# "State: ACTIVE". A missing Shell session (or an extension the Shell does not
# know yet) therefore always produces a non-zero exit code.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASE_UUID="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1], encoding="utf-8"))["uuid"])' "$ROOT/metadata.json")"
UUID="$BASE_UUID"
SUFFIX=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --uuid-suffix)
      [ "$#" -ge 2 ] || { printf 'FAIL: --uuid-suffix wymaga wartości\n' >&2; exit 2; }
      SUFFIX="$2"
      shift 2
      ;;
    --uuid-suffix=*)
      SUFFIX="${1#--uuid-suffix=}"
      shift
      ;;
    -h|--help)
      printf 'Usage: %s [--uuid-suffix X]\n' "$0"
      exit 0
      ;;
    *)
      printf 'FAIL: nieznany argument: %s\n' "$1" >&2
      exit 2
      ;;
  esac
done

if [ -n "$SUFFIX" ]; then
  UUID="$BASE_UUID-$SUFFIX"
fi

if ! command -v gnome-extensions >/dev/null 2>&1; then
  printf 'FAIL: brak gnome-extensions w PATH\n' >&2
  exit 1
fi

BUILD_DIR="$(mktemp -d "${TMPDIR:-/tmp}/spotlight-deploy.XXXXXX")"
cleanup() {
  rm -rf "$BUILD_DIR"
}
trap cleanup EXIT

PACK_SOURCE="$ROOT"
if [ -n "$SUFFIX" ]; then
  STAGE="$BUILD_DIR/stage"
  mkdir -p "$STAGE"
  cp "$ROOT/extension.js" "$ROOT/prefs.js" "$ROOT/metadata.json" "$ROOT/stylesheet.css" "$STAGE/"
  cp -R "$ROOT/lib" "$ROOT/schemas" "$STAGE/"
  python3 - "$STAGE/metadata.json" "$UUID" <<'PY'
import json
import sys

path, uuid = sys.argv[1], sys.argv[2]
with open(path, encoding="utf-8") as handle:
    metadata = json.load(handle)
metadata["uuid"] = uuid
with open(path, "w", encoding="utf-8") as handle:
    json.dump(metadata, handle, indent=2, ensure_ascii=False)
    handle.write("\n")
PY
  PACK_SOURCE="$STAGE"
fi

pack_output=""
if ! pack_output="$(
  cd "$PACK_SOURCE"
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

ZIP_FILE="$(find "$BUILD_DIR" -maxdepth 1 -type f -name '*.shell-extension.zip' -print -quit)"
if [ -z "$ZIP_FILE" ] || [ ! -f "$ZIP_FILE" ]; then
  printf 'FAIL: nie znaleziono spakowanego ZIP w %s\n' "$BUILD_DIR" >&2
  exit 1
fi

if ! gnome-extensions install --force "$ZIP_FILE"; then
  printf 'FAIL: gnome-extensions install nie powiódł się\n' >&2
  exit 1
fi

# disable/enable are best effort: they need an active Shell session, which is
# checked explicitly through `gnome-extensions info` below.
if ! gnome-extensions disable "$UUID" >/dev/null 2>&1; then
  printf 'INFO: nie można wyłączyć %s (brak sesji Shella?)\n' "$UUID" >&2
fi
if ! gnome-extensions enable "$UUID" >/dev/null 2>&1; then
  printf 'INFO: nie można włączyć %s (brak sesji Shella?)\n' "$UUID" >&2
fi

set +e
INFO="$(LC_ALL=C gnome-extensions info "$UUID" 2>&1)"
INFO_RC=$?
set -e
printf '%s\n' "$INFO"

if [ "$INFO_RC" -ne 0 ] ||
   ! printf '%s\n' "$INFO" | grep -Eq '(^|[[:space:]])State:[[:space:]]*ACTIVE([[:space:]]|$)'; then
  printf '%s\n' \
    "FAIL: rozszerzenie $UUID nie jest ACTIVE — zarejestruj UUID po zalogowaniu do sesji GNOME i włącz rozszerzenie." >&2
  exit 1
fi

printf 'OK: %s jest ACTIVE\n' "$UUID"