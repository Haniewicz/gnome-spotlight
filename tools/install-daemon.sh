#!/usr/bin/env bash
# Install gnome-spotlightd into the user's ~/.local tree and verify it over
# D-Bus. This is the development variant: the service runs `gjs -m` against
# the installed searchd entry point (there is no compiled GResource).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOME_DIR="${HOME:-$(getent passwd "$(id -u)" | cut -d: -f6)}"
INSTALL_DIR="$HOME_DIR/.local/lib/gnome-spotlightd"
DBUS_SERVICE_DIR="$HOME_DIR/.local/share/dbus-1/services"
DBUS_SERVICE="$DBUS_SERVICE_DIR/org.gnome.Spotlight.service"
UNIT_DIR="$HOME_DIR/.config/systemd/user"
UNIT_NAME="gnome-spotlightd.service"
UNIT_FILE="$UNIT_DIR/$UNIT_NAME"
BUS_NAME="org.gnome.Spotlight"
OBJECT_PATH="/org/gnome/Spotlight/Search"
SEARCH_IFACE="org.gnome.Spotlight.Search"

GJS_BIN="$(command -v gjs || true)"
if [ -z "$GJS_BIN" ]; then
  printf 'FAIL: brak gjs w PATH\n' >&2
  exit 1
fi

# The sandbox/test shell often exports neither variable even though a session
# bus is present. Infer the standard per-user location so busctl works.
if [ -z "${XDG_RUNTIME_DIR:-}" ] && [ -d "/run/user/$(id -u)" ]; then
  export XDG_RUNTIME_DIR="/run/user/$(id -u)"
fi
if [ -z "${DBUS_SESSION_BUS_ADDRESS:-}" ] &&
   [ -n "${XDG_RUNTIME_DIR:-}" ] &&
   [ -S "$XDG_RUNTIME_DIR/bus" ]; then
  export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"
fi
if [ -z "${DBUS_SESSION_BUS_ADDRESS:-}" ] && [ -z "${XDG_RUNTIME_DIR:-}" ]; then
  printf 'FAIL: brak sesyjnego D-Bus (XDG_RUNTIME_DIR/DBUS_SESSION_BUS_ADDRESS)\n' >&2
  exit 1
fi

printf 'INFO: instaluję daemon w %s\n' "$INSTALL_DIR"
case "$INSTALL_DIR" in
  */.local/lib/gnome-spotlightd) ;;
  *)
    printf 'FAIL: odmawiam usunięcia nieoczekiwanej ścieżki: %s\n' "$INSTALL_DIR" >&2
    exit 1
    ;;
esac
rm -rf "$INSTALL_DIR/searchd" "$INSTALL_DIR/lib"
mkdir -p "$INSTALL_DIR"
cp -R "$ROOT/searchd" "$INSTALL_DIR/searchd"
cp -R "$ROOT/lib" "$INSTALL_DIR/lib"

mkdir -p "$UNIT_DIR"

# Only one mechanism may own org.gnome.Spotlight. Prefer the systemd --user
# unit; when that manager is unavailable fall back to D-Bus activation and do
# not leave an enabled unit behind that could race the service file.
START_MECHANISM="D-Bus activation"
cat > "$UNIT_FILE" <<EOF
[Unit]
Description=GNOME Spotlight search daemon
Documentation=file://$ROOT/docs/DESIGN.md

[Service]
Type=simple
ExecStart=$GJS_BIN -m $INSTALL_DIR/searchd/main.js
Restart=on-failure
RestartSec=1
MemoryMax=256M

[Install]
WantedBy=default.target
EOF

systemd_ok=0
if command -v systemctl >/dev/null 2>&1 &&
   systemctl --user daemon-reload >/dev/null 2>&1; then
  if systemctl --user enable --now "$UNIT_NAME" >/dev/null 2>&1; then
    systemd_ok=1
  fi
fi

if [ "$systemd_ok" -eq 1 ]; then
  # systemd is the only owner: a stale D-Bus activation file would start a
  # second process that immediately loses the name race.
  rm -f "$DBUS_SERVICE"
  START_MECHANISM="systemd --user ($UNIT_NAME)"
  printf 'INFO: wpisano %s\n' "$UNIT_FILE"
  printf 'INFO: usunięto %s (jeden właściciel nazwy: systemd --user)\n' "$DBUS_SERVICE"
else
  systemctl --user disable --now "$UNIT_NAME" >/dev/null 2>&1 || true

  mkdir -p "$DBUS_SERVICE_DIR"
  cat > "$DBUS_SERVICE" <<EOF
[D-BUS Service]
Name=$BUS_NAME
Exec=$GJS_BIN -m $INSTALL_DIR/searchd/main.js
EOF
  printf 'INFO: wpisano %s\n' "$UNIT_FILE"
  printf 'INFO: wpisano %s\n' "$DBUS_SERVICE"
fi

printf 'INFO: daemon startuje przez: %s\n' "$START_MECHANISM"

# Ask the bus to pick up a newly written service file. This is harmless on
# buses that already watch the directory and on buses without the method.
busctl --user call org.freedesktop.DBus /org/freedesktop/DBus \
  org.freedesktop.DBus ReloadConfig >/dev/null 2>&1 || true

# Trigger activation (or use the already running systemd instance) and then
# verify both interfaces. busctl/introspection failures are reported verbatim.
activate() {
  busctl --user call "$BUS_NAME" "$OBJECT_PATH" "$SEARCH_IFACE" \
    Search ssi 'spot' '' 8 2>&1
}

search_output=""
search_error=""
activated=0
for _ in $(seq 1 40); do
  if search_output="$(activate)"; then
    activated=1
    break
  fi
  search_error="$search_output"
  search_output=""
  sleep 0.1
done
if [ "$activated" -ne 1 ] || [ -z "$search_output" ]; then
  printf 'FAIL: nie udało się aktywować %s\n' "$BUS_NAME" >&2
  [ -n "$search_error" ] && printf '%s\n' "$search_error" >&2
  exit 1
fi

introspect_output=""
introspected=0
for _ in $(seq 1 40); do
  if introspect_output="$(busctl --user introspect "$BUS_NAME" "$OBJECT_PATH" 2>&1)"; then
    introspected=1
    break
  fi
  introspect_output=""
  sleep 0.1
done

printf '%s\n' "$introspect_output"
if [ "$introspected" -ne 1 ]; then
  printf 'FAIL: busctl --user introspect %s %s nie powiódł się\n' \
    "$BUS_NAME" "$OBJECT_PATH" >&2
  exit 1
fi
if ! printf '%s\n' "$introspect_output" | grep -q 'org.gnome.Spotlight.Search'; then
  printf 'FAIL: busctl introspect nie pokazuje %s\n' "$SEARCH_IFACE" >&2
  exit 1
fi
if ! printf '%s\n' "$introspect_output" | grep -q 'org.gnome.Shell.SearchProvider2'; then
  printf 'FAIL: busctl introspect nie pokazuje org.gnome.Shell.SearchProvider2\n' >&2
  exit 1
fi

printf '%s\n' "$search_output"
if ! printf '%s\n' "$search_output" | grep -Eq 'aa\{sv\}s? [1-9][0-9]*'; then
  printf 'FAIL: Search("spot","",8) zwrócił pustą listę\n' >&2
  exit 1
fi

printf 'PASS: daemon działa (%s); Search("spot","",8) zwrócił wyniki\n' "$START_MECHANISM"
