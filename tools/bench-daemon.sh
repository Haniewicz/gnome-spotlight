#!/usr/bin/env bash
# Benchmark the running gnome-spotlightd over D-Bus: 100 busctl calls with a
# rotating query set. Fails when p95 > 30 ms or max > 150 ms (DESIGN §13).
set -euo pipefail

BUS_NAME="org.gnome.Spotlight"
OBJECT_PATH="/org/gnome/Spotlight/Search"
SEARCH_IFACE="org.gnome.Spotlight.Search"
COUNT=100
P95_LIMIT=30
MAX_LIMIT=150
QUERIES=('s' 'sp' 'spo' 'spot' 'x')

if [ -z "${XDG_RUNTIME_DIR:-}" ] && [ -d "/run/user/$(id -u)" ]; then
  export XDG_RUNTIME_DIR="/run/user/$(id -u)"
fi
if [ -z "${DBUS_SESSION_BUS_ADDRESS:-}" ] &&
   [ -n "${XDG_RUNTIME_DIR:-}" ] &&
   [ -S "$XDG_RUNTIME_DIR/bus" ]; then
  export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"
fi

call_search() {
  busctl --user call "$BUS_NAME" "$OBJECT_PATH" "$SEARCH_IFACE" \
    Search ssi "$1" '' 8 >/dev/null 2>&1
}

# Warm-up is deliberately outside the measured 100 calls: it also triggers
# D-Bus activation when the daemon is not running yet.
warmed=0
for _ in $(seq 1 40); do
  if call_search 'spot'; then
    warmed=1
    break
  fi
  sleep 0.1
done
if [ "$warmed" -ne 1 ]; then
  printf 'FAIL: nie można połączyć się z %s (uruchom tools/install-daemon.sh)\n' "$BUS_NAME" >&2
  exit 1
fi
for query in 'spot' 'spo' 'sp' 's'; do
  call_search "$query" || true
done

SAMPLES="$(mktemp "${TMPDIR:-/tmp}/spotlight-bench.XXXXXX")"
trap 'rm -f "$SAMPLES"' EXIT

for i in $(seq 1 "$COUNT"); do
  query="${QUERIES[$(( (i - 1) % ${#QUERIES[@]} ))]}"
  start_ns="$(date +%s%N)"
  if ! call_search "$query"; then
    printf 'FAIL: busctl call Search(%s,"",8) nie powiódł się (próba %d)\n' "$query" "$i" >&2
    exit 1
  fi
  end_ns="$(date +%s%N)"
  printf '%s\n' "$(( (end_ns - start_ns) / 1000000 ))" >> "$SAMPLES"
done

sort -n "$SAMPLES" -o "$SAMPLES"
p50="$(sed -n '50p' "$SAMPLES")"
p95="$(sed -n '95p' "$SAMPLES")"
max="$(sed -n "${COUNT}p" "$SAMPLES")"

printf 'BENCH: n=%d p50=%sms p95=%sms max=%sms\n' "$COUNT" "$p50" "$p95" "$max"

if [ "$p95" -gt "$P95_LIMIT" ] || [ "$max" -gt "$MAX_LIMIT" ]; then
  printf 'FAIL: bench p95<=%sms max<=%sms (p95=%sms max=%sms)\n' \
    "$P95_LIMIT" "$MAX_LIMIT" "$p95" "$max" >&2
  exit 1
fi

printf 'PASS: bench p95<=%sms max<=%sms\n' "$P95_LIMIT" "$MAX_LIMIT"