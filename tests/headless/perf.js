import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { ExtensionState } from 'resource:///org/gnome/shell/misc/extensionUtils.js';

const UUID = 'spotlight@haniewicz.dev';
const QUERIES = ['s', 'sp', 'spo', 'spot'];
const MAX_RESULTS = 8;
const MAX_COLD_MS = 400;
const MAX_WARM_MS = 120;
const MAX_CHAR_MS = 80;
const QUERY_TIMEOUT_MS = 5000;
const PASS_LINE = 'PASS: perf cold<=400ms warm<=120ms';

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
 * The first pass runs immediately after the enable() warm-up finishes: it is
 * allowed one cold spike up to 400 ms. The second pass is warm and must stay
 * within 120 ms per query; the modal char path must spend at most 80 ms per
 * character in provider search/render (the 120 ms debounce is not charged to
 * the character budget). BENCH lines carry the raw measurements.
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

    // The idle warm-up sources are scheduled by enable(). Let all of them run
    // before the cold pass so the first measured query is not charged for
    // get_installed()/get_all()/locate index faults.
    step = 'warmup';
    await waitFor(
      () => Array.isArray(state._warmupIds) && state._warmupIds.length === 0,
      'provider warm-up sources to finish',
      15000
    );
    await waitForQuiet();

    const measureSearch = async query => {
      const started = nowMs();
      const response = await state._registry.search(query, { limit: MAX_RESULTS });
      const elapsed = nowMs() - started;
      const count = Array.isArray(response?.results) ? response.results.length : 0;
      return { query, elapsed, count };
    };

    step = 'cold';
    const coldStats = [];
    for (const query of QUERIES) {
      const stat = await measureSearch(query);
      coldStats.push(stat);
      print(`BENCH cold search('${query}'): ${formatMs(stat.elapsed)} ms, results=${stat.count}`);
    }

    step = 'warm';
    const warmStats = [];
    for (const query of QUERIES) {
      const stat = await measureSearch(query);
      warmStats.push(stat);
      print(`BENCH warm search('${query}'): ${formatMs(stat.elapsed)} ms, results=${stat.count}`);
    }

    step = 'modal-open';
    state._toggle();
    const modal = state._modal;
    if (!modal || !modal.isOpen)
      throw new Error('modal did not open');

    let pendingKeystroke = null;
    let charSearchStarted = 0;
    let lastCharSearchMs = 0;

    const originalSetResults = modal.setResults;
    modal.setResults = function (sections) {
      if (charSearchStarted) {
        lastCharSearchMs = nowMs() - charSearchStarted;
        charSearchStarted = 0;
      }

      originalSetResults.call(this, sections);
      const resolve = pendingKeystroke;
      pendingKeystroke = null;
      if (resolve)
        resolve();
    };

    const originalPerformSearch = modal._performSearch;
    modal._performSearch = function (query, token) {
      charSearchStarted = nowMs();
      return originalPerformSearch.call(this, query, token);
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

    // Warm the Shell icon/style caches and the first paint; this query is not
    // part of the gate.
    step = 'modal-warmup';
    await typeAndWait('a');
    await waitForQuiet(200, 5000);

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

    const charStats = [];
    step = 'keystroke';
    try {
      for (const query of QUERIES) {
        const started = nowMs();
        await typeAndWait(query);

        const elapsed = nowMs() - started;
        charStats.push({ query, search: lastCharSearchMs, elapsed, rows: modal._rows.length });
        print(
          `BENCH warm char('${query}'): search=${formatMs(lastCharSearchMs)} ms, ` +
          `set-text=${formatMs(elapsed)} ms, rows=${modal._rows.length}, ` +
          `max-stall=${formatMs(stall.max)} ms`
        );
      }
    } finally {
      GLib.source_remove(stallId);
    }

    const failures = [];
    for (const stats of [coldStats, warmStats, charStats]) {
      for (const stat of stats) {
        if (stat.count !== undefined && stat.count > MAX_RESULTS)
          failures.push(`search('${stat.query}') returned ${stat.count} results`);
        if (stat.rows !== undefined && stat.rows > MAX_RESULTS)
          failures.push(`set_text('${stat.query}') rendered ${stat.rows} rows`);
      }
    }

    for (const stat of coldStats) {
      if (!(stat.elapsed <= MAX_COLD_MS))
        failures.push(`cold search('${stat.query}') took ${formatMs(stat.elapsed)} ms`);
    }
    for (const stat of warmStats) {
      if (!(stat.elapsed <= MAX_WARM_MS))
        failures.push(`warm search('${stat.query}') took ${formatMs(stat.elapsed)} ms`);
    }
    for (const stat of charStats) {
      if (!(stat.search <= MAX_CHAR_MS))
        failures.push(`warm char('${stat.query}') search took ${formatMs(stat.search)} ms`);
    }

    if (failures.length > 0) {
      for (const failure of failures)
        print(`FAIL: ${failure}`);
      throw new Error(failures.join('; '));
    }

    const maxCold = Math.max(...coldStats.map(stat => stat.elapsed));
    const maxWarm = Math.max(...warmStats.map(stat => stat.elapsed));
    const maxChar = Math.max(...charStats.map(stat => stat.search));
    const maxKeystroke = Math.max(...charStats.map(stat => stat.elapsed));
    print(
      `STATS: cold-max=${formatMs(maxCold)} ms, warm-max=${formatMs(maxWarm)} ms, ` +
      `char-max=${formatMs(maxChar)} ms, set-text-max=${formatMs(maxKeystroke)} ms, ` +
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
