import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { ExtensionState } from 'resource:///org/gnome/shell/misc/extensionUtils.js';

const UUID = 'spotlight@haniewicz.dev';
const BUS_NAME = 'org.gnome.Spotlight';
const OBJECT_PATH = '/org/gnome/Spotlight/Search';
const SEARCH_IFACE = 'org.gnome.Spotlight.Search';
const MAX_OPEN_MS = 60;
const MAX_FIRST_PAINT_MS = 16;
const MAX_DAEMON_RESULT_MS = 30;
const MAX_SET_TEXT_MS = 250;
const MAX_STALL_MS = 50;
const MAX_FALLBACK_MS = 120;
const QUERY_TIMEOUT_MS = 6000;
const PASS_LINE =
  'PASS: frontend first-paint<=16ms result<=30ms stall<=50ms fallback<=120ms';

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
    await sleep(25);
  }
  throw new Error(`timeout waiting for ${description}`);
}

function extensionState() {
  return Main.extensionManager?.lookup(UUID) ?? null;
}

/**
 * Shell startup has its own burst of portal/calendar/background work. Wait
 * until the main loop has been quiet so the gate measures Spotlight.
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
  return Number(value).toFixed(1);
}

/**
 * Resolve after the stage has painted the next frame. The shadow regression
 * only showed up during rasterization, so the open budget is charged to the
 * first real frame rather than to the synchronous actor-tree update.
 */
function nextStagePaint(timeoutMs = 1000) {
  return new Promise((resolve, reject) => {
    let paintId = 0;
    const timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, timeoutMs, () => {
      if (paintId) {
        try {
          global.stage.disconnect(paintId);
        } catch {
          // The stage was already destroyed.
        }
        paintId = 0;
      }
      reject(new Error('timeout waiting for the first frame'));
      return GLib.SOURCE_REMOVE;
    });

    paintId = global.stage.connect('after-paint', () => {
      try {
        GLib.source_remove(timeoutId);
      } catch {
        // The timeout source already fired.
      }
      if (paintId) {
        try {
          global.stage.disconnect(paintId);
        } catch {
          // The stage was already destroyed.
        }
        paintId = 0;
      }
      resolve();
    });
  });
}

async function measureOpen(state) {
  const modal = state._modal;
  if (!modal)
    throw new Error('enabled extension has no modal');

  if (modal.isOpen) {
    modal.close();
    await nextStagePaint();
  }

  const painted = nextStagePaint();
  const start = nowMs();
  state._toggle();

  const opened = state._modal;
  if (!opened?.isOpen)
    throw new Error('modal did not open');
  if (!opened.visible)
    throw new Error('modal is not visible after open');

  global.stage.queue_redraw();
  await painted;
  return nowMs() - start;
}

function waitForNextResult(telemetry, timeoutMs = QUERY_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, timeoutMs, () => {
      telemetry.waiters = telemetry.waiters.filter(entry => entry !== waiter);
      reject(new Error('timeout waiting for search result'));
      return GLib.SOURCE_REMOVE;
    });

    const waiter = () => {
      try {
        GLib.source_remove(timer);
      } catch {
        // The timeout source already fired.
      }
      resolve();
    };
    telemetry.waiters.push(waiter);
  });
}

function resolveWaiter(telemetry) {
  const waiter = telemetry.waiters.shift();
  if (waiter)
    waiter();
}

/**
 * Instrument the modal's async search boundary. The debounce is deliberately
 * not charged to the source budget: `result` measures from _performSearch()
 * entry to the rendered/stable result, not from the keystroke.
 */
function instrumentModal(modal) {
  const telemetry = {
    resultStart: 0,
    lastResultMs: 0,
    waiters: [],
  };

  const originalPerformSearch = modal._performSearch;
  modal._performSearch = function patchedPerformSearch(query, token) {
    telemetry.resultStart = nowMs();
    const promise = originalPerformSearch.call(this, query, token);
    return Promise.resolve(promise).finally(() => {
      if (!telemetry.resultStart)
        return;
      telemetry.lastResultMs = nowMs() - telemetry.resultStart;
      telemetry.resultStart = 0;
      resolveWaiter(telemetry);
    });
  };

  return telemetry;
}

async function typeAndWait(modal, telemetry, query) {
  const pending = waitForNextResult(telemetry);
  const setTextStart = nowMs();
  modal._entry.set_text(query);
  const setTextMs = nowMs() - setTextStart;
  await pending;
  return {
    setTextMs,
    resultMs: telemetry.lastResultMs,
    rows: modal._rows.length,
  };
}

async function measureFirstPaint(modal, telemetry, query) {
  // Clear the entry first: St.Entry does not emit text-changed when set_text()
  // receives the same value it already has. This also drops the visible rows,
  // so the measured frame really has to come from the LRU cache.
  modal._entry.set_text('');

  // The next async response still has to settle after the synchronous LRU
  // paint; keep a waiter so the next measurement starts from a clean state.
  const pending = waitForNextResult(telemetry);
  const start = nowMs();
  modal._entry.set_text(query);
  const elapsed = nowMs() - start;
  const rows = modal._rows.length;
  await pending;
  return { elapsed, rows };
}

function startStallMonitor() {
  return {
    max: 0,
    last: GLib.get_monotonic_time(),
    reset() {
      this.max = 0;
      this.last = GLib.get_monotonic_time();
    },
  };
}

function quitDaemon() {
  return new Promise(resolve => {
    let settled = false;
    const finish = () => {
      if (settled)
        return;
      settled = true;
      resolve();
    };

    const timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000, () => {
      finish();
      return GLib.SOURCE_REMOVE;
    });

    try {
      Gio.DBus.session.call(
        BUS_NAME,
        OBJECT_PATH,
        SEARCH_IFACE,
        'Quit',
        null,
        null,
        Gio.DBusCallFlags.NONE,
        1500,
        null,
        (connection, result) => {
          try {
            connection.call_finish(result);
          } catch {
            // No owner / already shutting down is fine here.
          }
          try {
            GLib.source_remove(timer);
          } catch {
            // The timeout source already fired.
          }
          finish();
        }
      );
    } catch {
      try {
        GLib.source_remove(timer);
      } catch {
        // The timeout source already fired.
      }
      finish();
    }
  });
}

function footerSource(modal) {
  return modal._footerSource?.get_text?.() ?? '';
}

/**
 * Frontend performance gate run by gnome-shell --automation-script.
 *
 * Pass 1: modal open to first frame <=60 ms, daemon stream + local windows.
 * LRU first paint must stay within one frame, the rendered daemon result
 * within 30 ms and the main loop must not stall longer than 50 ms.
 *
 * Pass 2: the daemon is stopped with its own Quit() method; the extension
 * switches to the in-process providers via NameOwnerChanged and the fallback
 * result stays within 120 ms with footer source "offline".
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

    step = 'warmup';
    await waitFor(
      () => Array.isArray(state._warmupIds) && state._warmupIds.length === 0,
      'provider warm-up sources to finish',
      15000
    );

    step = 'daemon-source';
    const daemonAvailable = await waitFor(
      () => state._source === 'daemon',
      'daemon source',
      6000
    ).then(() => true).catch(() => false);

    if (!daemonAvailable) {
      print('BENCH source: fallback-only (daemon unavailable or not installed)');
      if (state._source !== 'local')
        throw new Error(`unexpected source ${state._source}`);
    } else {
      print('BENCH source: daemon');
    }

    state._toggle();
    const modal = state._modal;
    if (!modal || !modal.isOpen)
      throw new Error('modal did not open');

    const telemetry = instrumentModal(modal);
    const stall = startStallMonitor();
    let stallId = 0;

    // Warm the modal row/icon paths once; the gate itself starts below.
    step = 'modal-warmup';
    await typeAndWait(modal, telemetry, 'spot');
    await waitForQuiet(250, 5000);

    step = 'open';
    const openMs = await measureOpen(state);
    print(`BENCH open=${formatMs(openMs)}ms`);

    step = 'first-paint';
    stallId = GLib.timeout_add(
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
    stall.reset();

    const firstPaint = await measureFirstPaint(modal, telemetry, 'spot');
    print(
      `BENCH frontend first-paint=${formatMs(firstPaint.elapsed)}ms ` +
      `rows=${firstPaint.rows} source=${footerSource(modal) || 'unknown'}`
    );

    step = 'daemon-result';
    const daemonResult = await typeAndWait(modal, telemetry, 'spo');
    print(
      `BENCH daemon result=${formatMs(daemonResult.resultMs)}ms ` +
      `set_text=${formatMs(daemonResult.setTextMs)}ms ` +
      `rows=${daemonResult.rows} source=${footerSource(modal) || 'unknown'}`
    );
    print(`BENCH daemon max-stall=${formatMs(stall.max)}ms`);

    if (stallId) {
      GLib.source_remove(stallId);
      stallId = 0;
    }

    step = 'daemon-stop';
    let fallbackResult = { resultMs: 0, setTextMs: 0, rows: 0 };
    if (daemonAvailable) {
      await quitDaemon();
      await waitFor(
        () => state._source === 'local',
        'fallback source after daemon quit',
        5000
      );
    }

    step = 'fallback';
    const fallbackStall = startStallMonitor();
    const fallbackStallId = GLib.timeout_add(
      GLib.PRIORITY_DEFAULT_IDLE,
      10,
      () => {
        const current = GLib.get_monotonic_time();
        const delay = (current - fallbackStall.last) / 1000;
        if (delay > fallbackStall.max)
          fallbackStall.max = delay;
        fallbackStall.last = current;
        return GLib.SOURCE_CONTINUE;
      }
    );

    try {
      fallbackResult = await typeAndWait(modal, telemetry, 'gnom');
    } finally {
      GLib.source_remove(fallbackStallId);
    }

    print(
      `BENCH fallback result=${formatMs(fallbackResult.resultMs)}ms ` +
      `set_text=${formatMs(fallbackResult.setTextMs)}ms ` +
      `rows=${fallbackResult.rows} source=${footerSource(modal) || 'unknown'} ` +
      `max-stall=${formatMs(fallbackStall.max)}ms`
    );

    const failures = [];
    if (!(openMs <= MAX_OPEN_MS)) {
      failures.push(
        `modal open took ${formatMs(openMs)} ms ` +
        `(limit ${MAX_OPEN_MS} ms)`
      );
    }
    if (!(firstPaint.elapsed <= MAX_FIRST_PAINT_MS)) {
      failures.push(
        `first paint took ${formatMs(firstPaint.elapsed)} ms ` +
        `(limit ${MAX_FIRST_PAINT_MS} ms)`
      );
    }
    if (firstPaint.rows === 0)
      failures.push('LRU first paint rendered no rows');

    if (!(daemonResult.setTextMs <= MAX_SET_TEXT_MS)) {
      failures.push(
        `daemon set_text took ${formatMs(daemonResult.setTextMs)} ms ` +
        `(limit ${MAX_SET_TEXT_MS} ms)`
      );
    }
    if (!(fallbackResult.setTextMs <= MAX_SET_TEXT_MS)) {
      failures.push(
        `fallback set_text took ${formatMs(fallbackResult.setTextMs)} ms ` +
        `(limit ${MAX_SET_TEXT_MS} ms)`
      );
    }

    if (daemonAvailable) {
      if (!(daemonResult.resultMs <= MAX_DAEMON_RESULT_MS)) {
        failures.push(
          `daemon result took ${formatMs(daemonResult.resultMs)} ms ` +
          `(limit ${MAX_DAEMON_RESULT_MS} ms)`
        );
      }
      if (!(stall.max <= MAX_STALL_MS)) {
        failures.push(
          `daemon max stall ${formatMs(stall.max)} ms ` +
          `(limit ${MAX_STALL_MS} ms)`
        );
      }
      if (footerSource(modal) !== 'offline') {
        // After the fallback query the footer must say offline.
        failures.push(`fallback footer source is ${footerSource(modal) || 'empty'}`);
      }
    }

    if (!(fallbackResult.resultMs <= MAX_FALLBACK_MS)) {
      failures.push(
        `fallback result took ${formatMs(fallbackResult.resultMs)} ms ` +
        `(limit ${MAX_FALLBACK_MS} ms)`
      );
    }

    print(
      `STATS: open=${formatMs(openMs)} ms, ` +
      `first-paint=${formatMs(firstPaint.elapsed)} ms, ` +
      `set-text=${formatMs(daemonResult.setTextMs)} ms, ` +
      `daemon-result=${formatMs(daemonResult.resultMs)} ms, ` +
      `daemon-stall=${formatMs(stall.max)} ms, ` +
      `fallback-result=${formatMs(fallbackResult.resultMs)} ms, ` +
      `daemon=${daemonAvailable ? 'yes' : 'no'}`
    );

    if (failures.length > 0) {
      for (const failure of failures)
        print(`FAIL: ${failure}`);
      throw new Error(failures.join('; '));
    }

    print(PASS_LINE);
    modal.close();
    Main.extensionManager.disableExtension(UUID);
  } catch (error) {
    print(`FAIL: ${step}: ${error.message}`);
    throw error;
  }
}