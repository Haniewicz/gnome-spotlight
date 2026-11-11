#!/usr/bin/env bash
# Benchmark the running gnome-spotlightd over D-Bus with ONE persistent gjs
# client and 100 sequential Search calls. Spawning busctl per sample used to
# charge the process spawn cost (~8 ms) to the daemon, so the old numbers were
# not a daemon measurement at all (DESIGN §13).
#
# Thresholds: p95 <= 30 ms, max <= 150 ms. The daemon's own stats.ms values
# (apps/files/settings) are printed separately.
set -euo pipefail

BUS_NAME="org.gnome.Spotlight"
OBJECT_PATH="/org/gnome/Spotlight/Search"
SEARCH_IFACE="org.gnome.Spotlight.Search"
COUNT=100
P95_LIMIT=30
MAX_LIMIT=150

if [ -z "${XDG_RUNTIME_DIR:-}" ] && [ -d "/run/user/$(id -u)" ]; then
  export XDG_RUNTIME_DIR="/run/user/$(id -u)"
fi
if [ -z "${DBUS_SESSION_BUS_ADDRESS:-}" ] &&
   [ -n "${XDG_RUNTIME_DIR:-}" ] &&
   [ -S "$XDG_RUNTIME_DIR/bus" ]; then
  export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"
fi

if ! command -v gjs >/dev/null 2>&1; then
  printf 'FAIL: brak gjs w PATH\n' >&2
  exit 1
fi

BENCH_DIR="$(mktemp -d "${TMPDIR:-/tmp}/spotlight-bench.XXXXXX")"
SCRIPT="$BENCH_DIR/bench.js"
trap 'rm -rf "$BENCH_DIR"' EXIT

cat > "$SCRIPT" <<'GJS'
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import system from 'system';

const BUS_NAME = 'org.gnome.Spotlight';
const OBJECT_PATH = '/org/gnome/Spotlight/Search';
const SEARCH_IFACE = 'org.gnome.Spotlight.Search';
const COUNT = 100;
const WARMUP = 20;
const P95_LIMIT = 30;
const MAX_LIMIT = 150;
const QUERIES = ['s', 'sp', 'spo', 'spot', 'x'];
const CALL_TIMEOUT_MS = 2000;

function parseStats(raw) {
  if (typeof raw !== 'string' || raw.trim() === '')
    return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

function callSearch(query) {
  return new Promise((resolve, reject) => {
    try {
      Gio.DBus.session.call(
        BUS_NAME,
        OBJECT_PATH,
        SEARCH_IFACE,
        'Search',
        new GLib.Variant('(ssi)', [query, '', 8]),
        new GLib.VariantType('(aa{sv}s)'),
        Gio.DBusCallFlags.NONE,
        CALL_TIMEOUT_MS,
        null,
        (connection, result) => {
          try {
            const reply = connection.call_finish(result);
            const [, rawStats] = reply.deep_unpack();
            resolve(parseStats(rawStats));
          } catch (error) {
            reject(error);
          }
        }
      );
    } catch (error) {
      reject(error);
    }
  });
}

function percentile(sorted, fraction) {
  if (sorted.length === 0)
    return 0;
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(fraction * sorted.length) - 1)
  );
  return sorted[index];
}

function summarize(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    p50: percentile(sorted, 0.50),
    p95: percentile(sorted, 0.95),
    max: sorted.length > 0 ? sorted[sorted.length - 1] : 0,
  };
}

function fmt(value) {
  return Number(value).toFixed(1);
}

const loop = new GLib.MainLoop(null, false);
let exitCode = 0;

async function main() {
  // Warm-up (outside the measured samples) also triggers D-Bus activation
  // when the daemon is installed but not running yet.
  for (let i = 0; i < WARMUP; i++)
    await callSearch(QUERIES[i % QUERIES.length]);

  const wall = [];
  const internal = new Map();

  for (let i = 0; i < COUNT; i++) {
    const query = QUERIES[i % QUERIES.length];
    const start = GLib.get_monotonic_time();
    const stats = await callSearch(query);
    const elapsedMs = (GLib.get_monotonic_time() - start) / 1000;
    wall.push(elapsedMs);

    const ms = stats && typeof stats === 'object' ? stats.ms : null;
    if (ms && typeof ms === 'object') {
      for (const [providerId, raw] of Object.entries(ms)) {
        const value = Number(raw);
        if (!Number.isFinite(value))
          continue;
        if (!internal.has(providerId))
          internal.set(providerId, []);
        internal.get(providerId).push(value);
      }
    }
  }

  const wallSummary = summarize(wall);
  print(
    `BENCH: n=${COUNT} p50=${fmt(wallSummary.p50)}ms ` +
    `p95=${fmt(wallSummary.p95)}ms max=${fmt(wallSummary.max)}ms`
  );

  const providers = [...internal.keys()].sort();
  if (providers.length === 0) {
    print('BENCH stats.ms: (daemon did not report provider timings)');
  } else {
    for (const providerId of providers) {
      const summary = summarize(internal.get(providerId));
      print(
        `BENCH stats.ms ${providerId}: p50=${fmt(summary.p50)}ms ` +
        `p95=${fmt(summary.p95)}ms max=${fmt(summary.max)}ms`
      );
    }
  }

  if (wallSummary.p95 > P95_LIMIT || wallSummary.max > MAX_LIMIT) {
    printerr(
      `FAIL: bench p95<=${P95_LIMIT}ms max<=${MAX_LIMIT}ms ` +
      `(p95=${fmt(wallSummary.p95)}ms max=${fmt(wallSummary.max)}ms)`
    );
    exitCode = 1;
  } else {
    print(`PASS: bench p95<=${P95_LIMIT}ms max<=${MAX_LIMIT}ms`);
  }
}

main()
  .catch(error => {
    printerr(`FAIL: nie można wykonać Search: ${error.message}`);
    exitCode = 1;
  })
  .finally(() => loop.quit());

loop.run();
system.exit(exitCode);
GJS

gjs -m "$SCRIPT"