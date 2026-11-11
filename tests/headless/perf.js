import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { ExtensionState } from 'resource:///org/gnome/shell/misc/extensionUtils.js';

const UUID = 'spotlight@haniewicz.dev';
const QUERIES = ['s', 'sp', 'spo', 'spot'];
const MAX_RESULTS = 8;
const MAX_SEARCH_MS = 150;
const MAX_KEYSTROKE_MS = 250;
const MAX_STALL_MS = 100;
const QUERY_TIMEOUT_MS = 5000;
const PASS_LINE =
  'PASS: perf search<=8 latency<150ms keystroke<250ms stall<100ms';

function sleep(milliseconds) {
  return new Promise(resolve => {
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, milliseconds, () => {
      resolve();
      return GLib.SOURCE_REMOVE;
    });
  });
}

async function waitFor(predicate, description, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value)
      return value;
    await sleep(50);
  }
  throw new Error(`timeout waiting for ${description}`);
}

function extensionState() {
  return Main.extensionManager?.lookup(UUID) ?? null;
}

/**
 * Shell startup has its own burst of portal/calendar/background work. Wait
 * until the main loop has been quiet for half a second so the gate measures
 * Spotlight, not GNOME Shell's boot sequence.
 */
async function waitForQuiet(quietMs = 500, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let last = GLib.get_monotonic_time();
  let quietSince = 0;

  while (Date.now() < deadline) {
    await sleep(50);
    const current = GLib.get_monotonic_time();
    const gap = (current - last) / 1000;
    last = current;

    if (gap < 20) {
      if (quietSince === 0)
        quietSince = Date.now();
      if (Date.now() - quietSince >= quietMs)
        return;
    } else {
      quietSince = 0;
    }
  }
}

function nowMs() {
  return GLib.get_monotonic_time() / 1000;
}

function formatMs(value) {
  return value.toFixed(1);
}

/**
 * Headless performance gate run by gnome-shell --automation-script.
 *
 * It measures the registry directly (search latency and result count) and the
 * real modal path (`set_text` -> debounce -> async search -> setResults). An
 * idle source wakes every 10 ms during the keystroke loop and records the
 * largest main-loop delay, which exposes any remaining synchronous stall.
 */
export async function run() {
  let step = 'enable';
  try {
    Main.extensionManager.enableExtension(UUID);
    const extension = await waitFor(
      () => {
        const candidate = extensionState();
        return candidate?.state === ExtensionState.ACTIVE ? candidate : null;
      },
      `extension ${UUID} to become ACTIVE`
    );

    const state = extension.stateObj;
    if (!state?._registry)
      throw new Error('enabled extension has no registry');

    await waitForQuiet();

    const searchStats = [];
    for (const query of QUERIES) {
      const started = nowMs();
      const response = await state._registry.search(query);
      const elapsed = nowMs() - started;
      const count = Array.isArray(response?.results) ? response.results.length : 0;

      searchStats.push({ query, elapsed, count });
      print(`BENCH search('${query}'): ${formatMs(elapsed)} ms, results=${count}`);
    }

    step = 'modal-open';
    state._toggle();
    const modal = state._modal;
    if (!modal || !modal.isOpen)
      throw new Error('modal did not open');

    let pendingKeystroke = null;
    const originalSetResults = modal.setResults;
    modal.setResults = function (sections) {
      originalSetResults.call(this, sections);
      const resolve = pendingKeystroke;
      pendingKeystroke = null;
      if (resolve)
        resolve();
    };

    const typeAndWait = query => new Promise((resolve, reject) => {
      const timeoutId = GLib.timeout_add(
        GLib.PRIORITY_DEFAULT,
        QUERY_TIMEOUT_MS,
        () => {
          pendingKeystroke = null;
          reject(new Error(`timeout waiting for results after typing ${query}`));
          return GLib.SOURCE_REMOVE;
        }
      );

      pendingKeystroke = () => {
        GLib.source_remove(timeoutId);
        resolve();
      };

      try {
        modal._entry.set_text(query);
      } catch (error) {
        pendingKeystroke = null;
        GLib.source_remove(timeoutId);
        reject(error);
      }
    });

    // Warm up the Shell's icon/style caches and let the first paint finish.
    // This is deliberately not one of the measured queries; the gate below
    // still runs the real debounce -> search -> setResults path.
    step = 'warmup';
    await typeAndWait('a');
    await waitForQuiet(250, 5000);

    const stall = {
      max: 0,
      last: GLib.get_monotonic_time(),
    };
    const stallId = GLib.timeout_add(
      GLib.PRIORITY_DEFAULT_IDLE,
      10,
      () => {
        const current = GLib.get_monotonic_time();
        const delay = (current - stall.last) / 1000;
        if (delay > stall.max)
          stall.max = delay;
        stall.last = current;
        return GLib.SOURCE_CONTINUE;
      }
    );

    const keystrokeStats = [];
    step = 'keystroke';
    try {
      for (const query of QUERIES) {
        const started = nowMs();
        await typeAndWait(query);

        const elapsed = nowMs() - started;
        keystrokeStats.push({ query, elapsed, rows: modal._rows.length });
        print(
          `BENCH set_text('${query}'): ${formatMs(elapsed)} ms, ` +
          `rows=${modal._rows.length}, max-stall=${formatMs(stall.max)} ms`
        );
      }
    } finally {
      GLib.source_remove(stallId);
    }

    const failures = [];
    for (const stat of searchStats) {
      if (stat.count > MAX_RESULTS)
        failures.push(`search('${stat.query}') returned ${stat.count} results`);
      if (!(stat.elapsed < MAX_SEARCH_MS))
        failures.push(`search('${stat.query}') took ${formatMs(stat.elapsed)} ms`);
    }
    for (const stat of keystrokeStats) {
      if (!(stat.elapsed < MAX_KEYSTROKE_MS))
        failures.push(
          `set_text('${stat.query}') took ${formatMs(stat.elapsed)} ms`
        );
    }
    if (!(stall.max < MAX_STALL_MS))
      failures.push(`main loop stalled for ${formatMs(stall.max)} ms`);

    if (failures.length > 0) {
      for (const failure of failures)
        print(`FAIL: ${failure}`);
      throw new Error(failures.join('; '));
    }

    const maxSearch = Math.max(...searchStats.map(stat => stat.elapsed));
    const maxKeystroke = Math.max(...keystrokeStats.map(stat => stat.elapsed));
    print(
      `STATS: max-search=${formatMs(maxSearch)} ms, ` +
      `max-keystroke=${formatMs(maxKeystroke)} ms, ` +
      `max-stall=${formatMs(stall.max)} ms`
    );
    print(PASS_LINE);

    modal.close();
    Main.extensionManager.disableExtension(UUID);
  } catch (error) {
    print(`FAIL: ${step}: ${error.message}`);
    throw error;
  }
}