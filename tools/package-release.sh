#!/usr/bin/env bash
# Build the Spotlight release artifacts under dist/<version>/.
#
# Usage: tools/package-release.sh [--version X.Y.Z]
#
# This script never publishes anything and never touches ~/.local. It only
# writes to dist/ in the repository (plus a temporary staging directory).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST_ROOT="$ROOT/dist"
VERSION=""
VERSION_OVERRIDE=""

usage() {
  printf 'Usage: %s [--version X.Y.Z]\n' "$0"
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --version)
      [ "$#" -ge 2 ] || { printf 'FAIL: --version wymaga wartości\n' >&2; exit 2; }
      VERSION_OVERRIDE="$2"
      shift 2
      ;;
    --version=*)
      VERSION_OVERRIDE="${1#--version=}"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      printf 'FAIL: nieznany argument: %s\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if ! command -v gnome-extensions >/dev/null 2>&1; then
  printf 'FAIL: brak gnome-extensions w PATH\n' >&2
  exit 1
fi
if ! command -v tar >/dev/null 2>&1 ||
   ! command -v sha256sum >/dev/null 2>&1; then
  printf 'FAIL: brak tar albo sha256sum w PATH\n' >&2
  exit 1
fi

METADATA_VERSION="$(python3 - "$ROOT/metadata.json" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    metadata = json.load(handle)
version = metadata.get("version")
if version is None or str(version).strip() == "":
    raise SystemExit("metadata.json has no version")
print(str(version).strip())
PY
)"

if [ -n "$VERSION_OVERRIDE" ]; then
  VERSION="$VERSION_OVERRIDE"
else
  VERSION="$METADATA_VERSION"
fi

case "$VERSION" in
  ''|.|..|*[!0-9A-Za-z._+-]*)
    printf 'FAIL: nieprawidłowa wersja: %s\n' "$VERSION" >&2
    exit 2
    ;;
esac

DIST_DIR="$DIST_ROOT/$VERSION"
case "$DIST_DIR" in
  "$ROOT"/dist/*) ;;
  *)
    printf 'FAIL: odmawiam zapisu poza dist/: %s\n' "$DIST_DIR" >&2
    exit 1
    ;;
esac

BUILD_DIR="$(mktemp -d "${TMPDIR:-/tmp}/spotlight-release.XXXXXX")"
cleanup() {
  rm -rf "$BUILD_DIR"
}
trap cleanup EXIT

# Idempotent: a previous run for the same version is replaced as a whole.
rm -rf "$DIST_DIR"
mkdir -p "$DIST_DIR"

EXT_STAGE="$BUILD_DIR/extension"
mkdir -p "$EXT_STAGE"
cp "$ROOT/extension.js" "$ROOT/prefs.js" "$ROOT/metadata.json" \
  "$ROOT/stylesheet.css" "$EXT_STAGE/"
cp -R "$ROOT/lib" "$ROOT/schemas" "$EXT_STAGE/"

# The requested version lives only in the staging copy; the repository's
# metadata.json stays untouched.
if [ -n "$VERSION_OVERRIDE" ]; then
  python3 - "$EXT_STAGE/metadata.json" "$VERSION" <<'PY'
import json
import sys

path, version = sys.argv[1], sys.argv[2]
with open(path, encoding="utf-8") as handle:
    metadata = json.load(handle)
metadata["version"] = version
with open(path, "w", encoding="utf-8") as handle:
    json.dump(metadata, handle, ensure_ascii=False, indent=2)
    handle.write("\n")
PY
fi

UUID="$(python3 - "$EXT_STAGE/metadata.json" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    print(json.load(handle)["uuid"])
PY
)"

EXT_ZIP_NAME="${UUID}.shell-extension.zip"
if ! pack_output="$(
  cd "$EXT_STAGE"
  gnome-extensions pack --force \
    --out-dir "$DIST_DIR" \
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

PACKED_ZIP=""
for candidate in "$DIST_DIR"/*.shell-extension.zip; do
  [ -f "$candidate" ] || continue
  PACKED_ZIP="$candidate"
  break
done
if [ -z "$PACKED_ZIP" ]; then
  printf 'FAIL: gnome-extensions pack nie utworzył ZIP\n' >&2
  exit 1
fi
if [ "$(basename "$PACKED_ZIP")" != "$EXT_ZIP_NAME" ]; then
  mv "$PACKED_ZIP" "$DIST_DIR/$EXT_ZIP_NAME"
fi

DAEMON_STAGE="$BUILD_DIR/daemon"
mkdir -p "$DAEMON_STAGE/tools" "$DAEMON_STAGE/docs"
cp -R "$ROOT/searchd" "$ROOT/lib" "$DAEMON_STAGE/"
cp "$ROOT/tools/install-daemon.sh" "$DAEMON_STAGE/tools/"
cp "$ROOT/README.md" "$DAEMON_STAGE/README.md"
cp "$ROOT/docs/DESIGN.md" "$DAEMON_STAGE/DESIGN.md"
cp "$ROOT/docs/DESIGN.md" "$DAEMON_STAGE/docs/DESIGN.md"

DAEMON_TAR_NAME="gnome-spotlightd-${VERSION}.tar.gz"
tar -czf "$DIST_DIR/$DAEMON_TAR_NAME" \
  -C "$DAEMON_STAGE" \
  searchd lib tools/install-daemon.sh README.md DESIGN.md docs/DESIGN.md

EXT_REL="dist/${VERSION}/${EXT_ZIP_NAME}"
DAEMON_REL="dist/${VERSION}/${DAEMON_TAR_NAME}"
(
  cd "$ROOT"
  sha256sum "$EXT_REL" "$DAEMON_REL" > "$DIST_DIR/SHA256SUMS.txt"
)

printf 'OK: artefakty w %s\n' "$DIST_DIR"
printf '  %s\n' "$EXT_ZIP_NAME" "$DAEMON_TAR_NAME" 'SHA256SUMS.txt'