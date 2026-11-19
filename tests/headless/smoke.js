import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { ExtensionState } from 'resource:///org/gnome/shell/misc/extensionUtils.js';

import { parseActions } from '../../lib/action-runner.js';
import { normalizeDaemonResult } from '../../lib/daemonClient.js';
import { normalizeResultActions } from '../../lib/searchStream.js';
import { planTile } from '../../lib/window-actions.js';
import { bmsBlurAvailable, initBmsBlur } from '../../lib/ui/backdrop.js';

const UUID = 'spotlight@haniewicz.dev';
const COEXIST_UUID = `${UUID}-coexist`;
const DAEMON_BUS_NAME = 'org.gnome.Spotlight';
const DAEMON_OBJECT_PATH = '/org/gnome/Spotlight/Search';
const DAEMON_SEARCH_INTERFACE = 'org.gnome.Spotlight.Search';
const DAEMON_SEARCH_REPLY = '(aa{sv}s)';
const MARKERS = [
  'window-actions',
  'modal-open',
  'compact-default',
  'expand-on-query',
  'space-types',
  'modal-typed',
  'modal-esc',
  'modal-closed',
  'screenshot-print-key',
  'veil-rounded',
  'preview-hidden-default',
  'preview-sidebar-toggle',
  'preview-ctrl-space',
  'preview-text',
  'preview-image',
  'scroll-overflow',
  'scroll-keyboard',
  'scroll-wheel',
  'blur-off-default',
  'blur-clone',
  'blur-destroyed',
  'blur-off-by-default',
  'blur-applied',
  'blur-layers',
  'blur-window-clone',
  'blur-height-stable',
  'blur-effect',
  'blur-corner-radius',
  'blur-teardown',
  'clipboard-item',
  'action-menu',
  'action-menu-anchored',
  'action-menu-rightclick',
  'tab-sections',
  'activate-copy',
  'activate-dbus',
];

let daemonProcess = null;

// 3x2 PNG (red/green top row, blue/white bottom row). Keeping the bytes in
// the script avoids a binary fixture and makes the image preview smoke
// independent of the session's icon theme or file index.
const SMOKE_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAYAAACddGYaAAAAFElEQVR4nGP4z8DwHwwZ/kNIGAcAlYQL9edHRsgAAAAASUVORK5CYII=';

function writeSmokePng() {
  const cacheDir = GLib.get_user_cache_dir();
  GLib.mkdir_with_parents(cacheDir, 0o755);
  const path = GLib.build_filenamev([cacheDir, 'spotlight-smoke.png']);
  const bytes = GLib.base64_decode(SMOKE_PNG_BASE64);
  if (!GLib.file_set_contents(path, bytes))
    throw new Error(`cannot write smoke PNG to ${path}`);
  return path;
}

function sleep(milliseconds) {
  return new Promise(resolve => {
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, milliseconds, () => {
      resolve();
      return GLib.SOURCE_REMOVE;
    });
  });
}

function readClipboardText() {
  return new Promise(resolve => {
    let clipboard = null;
    try {
      clipboard = St.Clipboard.get_default();
    } catch {
      resolve('');
      return;
    }

    const type = St.ClipboardType.CLIPBOARD;
    if (clipboard.get_text.length < 2) {
      try {
        resolve(String(clipboard.get_text(type) ?? ''));
      } catch {
        resolve('');
      }
      return;
    }

    try {
      clipboard.get_text(type, (first, second) => {
        if (typeof second === 'string')
          resolve(second);
        else
          resolve(typeof first === 'string' ? first : '');
      });
    } catch {
      resolve('');
    }
  });
}

async function waitForClipboard(expected, description, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await readClipboardText() === expected)
      return;
    await sleep(50);
  }
  throw new Error(`timeout waiting for ${description}`);
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

function dbusCall(busName, objectPath, interfaceName, name, parameters,
  replyType = null, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    let connection = null;
    try {
      connection = Gio.DBus.session;
    } catch (error) {
      reject(error);
      return;
    }

    connection.call(
      busName,
      objectPath,
      interfaceName,
      name,
      parameters,
      replyType ? new GLib.VariantType(replyType) : null,
      Gio.DBusCallFlags.NONE,
      timeoutMs,
      null,
      (source, result) => {
        try {
          resolve(source.call_finish(result));
        } catch (error) {
          reject(error);
        }
      }
    );
  });
}

async function daemonOwnsBus() {
  try {
    const reply = await dbusCall(
      'org.freedesktop.DBus',
      '/org/freedesktop/DBus',
      'org.freedesktop.DBus',
      'NameHasOwner',
      new GLib.Variant('(s)', [DAEMON_BUS_NAME]),
      '(b)',
      1000
    );
    return Boolean(reply.deep_unpack()[0]);
  } catch {
    return false;
  }
}

/**
 * The smoke session is a private dbus-run-session, so a daemon started outside
 * it cannot answer. Start gnome-spotlightd from the repository when the name
 * is unowned; the second smoke variant is skipped if that is not possible.
 */
async function ensureDaemon() {
  if (await daemonOwnsBus())
    return true;

  const gjs = GLib.find_program_in_path('gjs');
  if (!gjs)
    return false;

  const smokePath = GLib.filename_from_uri(import.meta.url)[0];
  const root = GLib.path_get_dirname(
    GLib.path_get_dirname(GLib.path_get_dirname(smokePath))
  );
  const daemonPath = GLib.build_filenamev([root, 'searchd', 'main.js']);
  if (!GLib.file_test(daemonPath, GLib.FileTest.IS_REGULAR))
    return false;

  try {
    daemonProcess = Gio.Subprocess.new(
      [gjs, '-m', daemonPath],
      Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE
    );
  } catch {
    daemonProcess = null;
    return false;
  }

  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await daemonOwnsBus())
      return true;
    await sleep(50);
  }

  stopDaemon();
  return false;
}

function stopDaemon() {
  const process = daemonProcess;
  daemonProcess = null;
  if (!process)
    return;

  try {
    process.send_signal(15);
  } catch {
    // The daemon may already be gone with the private bus.
  }
}

async function daemonSearchResults(query) {
  const reply = await dbusCall(
    DAEMON_BUS_NAME,
    DAEMON_OBJECT_PATH,
    DAEMON_SEARCH_INTERFACE,
    'Search',
    new GLib.Variant('(ssi)', [query, '', 20]),
    DAEMON_SEARCH_REPLY,
    3000
  );
  const [rawResults] = reply.deep_unpack();
  return Array.isArray(rawResults) ? rawResults : [];
}

/**
 * Fetch a real a{sv} result whose serialized actions parse to a primary
 * action. Raw D-Bus values are Variants, so this also covers the regression
 * where parseActions() only understood strings and plain objects.
 */
async function actionableDaemonResult() {
  for (const query of ['gnome', 'settings', 'terminal']) {
    let results = [];
    try {
      results = await daemonSearchResults(query);
    } catch {
      continue;
    }

    for (const raw of results) {
      const parsed = parseActions(raw);
      if (parsed.primary && parsed.primary.type)
        return raw;
    }
  }
  return null;
}

function extensionState(uuid = UUID) {
  return Main.extensionManager?.lookup(uuid) ?? null;
}

function assert(condition, step, message) {
  if (!condition)
    throw new Error(`${step}: ${message}`);
}

function smokeResults(count, prefix) {
  return [{
    id: `${prefix}-section`,
    title: 'Scroll',
    results: Array.from({ length: count }, (_value, index) => ({
      id: `${prefix}-${index}`,
      providerId: prefix,
      title: `${prefix} ${index + 1}`,
      subtitle: `wynik ${index + 1}`,
      kind: 'Test',
    })),
  }];
}

function actorEffects(actor) {
  const effects = [];
  const stack = [actor];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current)
      continue;
    try {
      effects.push(...(current.get_effects?.() ?? []));
    } catch {
      // A destroyed actor may already reject property access.
    }
    let children = [];
    try {
      children = current.get_children?.() ?? [];
    } catch {
      children = [];
    }
    stack.push(...children);
  }
  return effects;
}

function descendantActors(actor) {
  const actors = [];
  const stack = [actor];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current)
      continue;
    actors.push(current);
    let children = [];
    try {
      children = current.get_children?.() ?? [];
    } catch {
      children = [];
    }
    // Stack-based traversal has to push children in reverse: popping from the
    // end otherwise yields reverse paint order, so a "first child" assert
    // silently compares the LAST painted layer.
    for (let i = children.length - 1; i >= 0; i--)
      stack.push(children[i]);
  }
  return actors;
}

function cloneSources(actor) {
  return descendantActors(actor)
    .filter(child =>
      typeof child?.get_source === 'function' ||
      Object.prototype.hasOwnProperty.call(child ?? {}, 'source')
    )
    .map(clone => {
      try {
        return clone.get_source?.() ?? clone.source ?? null;
      } catch {
        return null;
      }
    });
}

function verticalInsets(actor) {
  try {
    const node = actor?.get_theme_node?.();
    if (!node)
      return 0;
    const side = St.Side;
    let inset = 0;
    for (const edge of [side.TOP, side.BOTTOM]) {
      inset += Number(node.get_padding?.(edge) ?? 0);
      inset += Number(node.get_border_width?.(edge) ?? 0);
    }
    return inset;
  } catch {
    return 0;
  }
}

function expectedPanelContentHeight(modal) {
  const searchRow = modal._entry?.get_parent?.() ?? null;
  return Number(searchRow?.height ?? 0) +
    Number(modal._body?.height ?? 0) +
    Number(modal._footer?.height ?? 0) +
    verticalInsets(modal._panelContent) +
    verticalInsets(modal._panel);
}

function pressEscape(modal) {
  return modal._onCapturedEvent(modal, {
    type: () => Clutter.EventType.KEY_PRESS,
    get_key_symbol: () => Clutter.KEY_Escape,
    get_state: () => 0,
  });
}

function pressKey(modal, symbol, state = 0) {
  return modal._onCapturedEvent(modal, {
    type: () => Clutter.EventType.KEY_PRESS,
    get_key_symbol: () => symbol,
    get_state: () => state,
  });
}

function screenshotFileSize(path) {
  try {
    const info = Gio.File.new_for_path(path).query_info(
      'standard::size',
      Gio.FileQueryInfoFlags.NONE,
      null
    );
    return Number(info.get_size());
  } catch {
    return -1;
  }
}

function captureScreenshotToFile(path) {
  return new Promise((resolve, reject) => {
    let screenshot = null;
    try {
      screenshot = new Shell.Screenshot();
    } catch (error) {
      reject(new Error(`Shell.Screenshot unavailable: ${error.message}`));
      return;
    }

    let stream = null;
    let settled = false;
    const finish = (source, result) => {
      if (settled)
        return;

      let failure = null;
      let savedPath = path;
      try {
        const outcome = source.screenshot_finish(result);
        if (typeof outcome === 'string')
          savedPath = outcome;
        else if (Array.isArray(outcome) &&
            outcome.length > 0 && outcome[0] === false)
          failure = new Error('screenshot_finish returned false');
      } catch (error) {
        failure = error;
      }

      if (!failure && savedPath && savedPath !== path) {
        try {
          Gio.File.new_for_path(savedPath).copy(
            Gio.File.new_for_path(path),
            Gio.FileCopyFlags.OVERWRITE,
            null,
            null
          );
        } catch (error) {
          failure = error;
        }
      }

      settled = true;
      try {
        stream?.close(null);
      } catch {
        // screenshot_finish() already completed; an already-closed stream is
        // not a capture failure.
      }
      if (failure)
        reject(failure instanceof Error ? failure : new Error(String(failure)));
      else
        resolve(path);
    };

    try {
      // Shell 51 writes into a Gio stream; older Shell versions return the
      // filename from screenshot_finish(). The smoke supports both so the
      // marker fails for a real capture problem, not for API version skew.
      if (screenshot.screenshot.length >= 3) {
        stream = Gio.File.new_for_path(path).replace(
          null,
          false,
          Gio.FileCreateFlags.REPLACE_DESTINATION,
          null
        );
        screenshot.screenshot(false, stream, finish);
      } else {
        screenshot.screenshot(false, finish);
      }
    } catch (error) {
      if (!settled) {
        settled = true;
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    }
  });
}

function actionMenuItems(menu) {
  if (typeof menu?._getMenuItems === 'function')
    return menu._getMenuItems();
  return menu?.box?.get_children?.() ?? [];
}

/**
 * Headless smoke script run by gnome-shell --automation-script.
 *
 * Sequence: enable primary -> enable second copy with another UUID -> both
 * ACTIVE -> keybinding handler -> modal visible -> type "spo" -> entry has
 * 3 chars -> Escape -> modal hidden -> disable both.
 */
export async function run() {
  let step = 'window-actions';
  let dbusActivation = false;
  let blurCloneAvailable = true;
  try {
    // Meta.Window cannot be constructed from an automation script, so the
    // window-actions marker exercises the pure planner in the Shell context.
    const workArea = { x: 0, y: 0, width: 1921, height: 1080 };
    const left = planTile(workArea, 'left');
    const right = planTile(workArea, 'right');
    assert(left.width === 960, step, `left width is ${left.width}, expected 960`);
    assert(right.x === 960, step, `right x is ${right.x}, expected 960`);
    assert(right.width === 961, step,
      `right width is ${right.width}, expected 961`);
    assert(left.x + left.width === right.x, step,
      'right tile does not start where the left tile ends');
    assert(left.width + right.width === 1921, step,
      `widths sum to ${left.width + right.width}, expected 1921`);
    assert(left.x === 0 && left.y === 0 && left.height === 1080, step,
      'left tile does not cover the full work-area height');
    assert(right.y === 0 && right.height === 1080, step,
      'right tile does not cover the full work-area height');

    step = 'enable';
    Main.extensionManager.enableExtension(UUID);
    step = 'enable';
    const extension = await waitFor(
      () => {
        const candidate = extensionState();
        return candidate?.state === ExtensionState.ACTIVE ? candidate : null;
      },
      `extension ${UUID} to become ACTIVE`
    );
    assert(extension.stateObj, step, 'extension has no state object');

    step = 'coexist-enable';
    Main.extensionManager.enableExtension(COEXIST_UUID);
    const coexist = await waitFor(
      () => {
        const candidate = extensionState(COEXIST_UUID);
        return candidate?.state === ExtensionState.ACTIVE ? candidate : null;
      },
      `extension ${COEXIST_UUID} to become ACTIVE`
    );
    assert(coexist.stateObj, step, 'second copy has no state object');
    assert(coexist.stateObj._modal, step, 'second copy did not create its modal');
    assert(
      extension.state === ExtensionState.ACTIVE &&
        coexist.state === ExtensionState.ACTIVE,
      step,
      'both extension copies are not ACTIVE simultaneously'
    );

    step = 'modal-open';
    const clipboardText = `smoke-schowek-${Date.now()}`;
    const screenshotModesBeforeOpen =
      Main.wm?._allowedKeybindings?.['show-screenshot-ui'];
    St.Clipboard.get_default().set_text(
      St.ClipboardType.CLIPBOARD,
      clipboardText
    );
    extension.stateObj._toggle();
    const modal = extension.stateObj._modal;
    assert(modal, step, 'modal was not created');
    assert(modal.isOpen === true, step, 'keybinding handler did not open the modal');
    assert(modal.visible === true, step, 'modal is not visible');

    step = 'screenshot-print-key';
    const screenshotUI = Main.screenshotUI;
    assert(
      screenshotUI && typeof screenshotUI.open === 'function',
      step,
      'Main.screenshotUI.open is unavailable in this Shell'
    );
    const originalScreenshotOpen = screenshotUI.open;
    let screenshotOpenCalls = 0;
    screenshotUI.open = function openStub() {
      screenshotOpenCalls++;
    };
    let printEvent;
    try {
      printEvent = pressKey(modal, Clutter.KEY_Print);
    } finally {
      screenshotUI.open = originalScreenshotOpen;
    }
    assert(printEvent === Clutter.EVENT_STOP, step,
      'Print was not consumed by the modal');
    assert(screenshotOpenCalls === 1, step,
      `Main.screenshotUI.open was called ${screenshotOpenCalls} times, expected 1`);

    step = 'blur-off-by-default';
    assert(modal._panelBlurActor === null, step,
      'blur backdrop exists before blur-enabled was turned on');

    step = 'compact-default';
    assert(modal._compact === true, step, 'modal did not start compact');
    assert(modal._body.visible === false, step, 'result body is visible without a query');
    assert(modal._rows.length === 0, step, 'rows were rendered without a query');

    step = 'clipboard-item';
    modal._entry.set_text('cb ');
    const clipboardRow = await waitFor(
      () => modal._rows.find(row =>
        row.result?.providerId === 'clipboard' &&
        String(row.result?.title ?? '').includes(clipboardText)
      ),
      'clipboard history row'
    );
    assert(clipboardRow, step, 'clipboard row was not rendered');
    assert(
      String(clipboardRow.result?.title ?? '').includes(clipboardText),
      step,
      'clipboard row does not contain the text set in St.Clipboard'
    );

    const clipboardEscape = pressEscape(modal);
    assert(clipboardEscape === Clutter.EVENT_STOP, step, 'Escape was not consumed');
    assert(modal.isOpen === false, step, 'modal is still open after clipboard check');
    assert(modal.visible === false, step, 'modal is still visible after clipboard check');

    // Reopen for the remaining modal and preview checks.
    extension.stateObj._toggle();
    assert(modal.isOpen === true, step, 'modal did not reopen after clipboard check');

    step = 'expand-on-query';
    modal._entry.set_text('s');
    assert(modal._body.visible === true, step, 'result body did not expand after typing');
    assert(modal._compact === false, step, 'modal stayed compact after typing');
    modal._entry.set_text('');
    assert(modal._body.visible === false, step, 'result body did not collapse after clearing');
    assert(modal._rows.length === 0, step, 'rows survived clearing the query');
    modal._entry.set_text('s');
    modal._cancelSearch();
    modal._setCompact(false);  // kompakt startuje bez listy wyników
    modal.setResults([{
      id: 'smoke-expand',
      title: 'Smoke',
      results: [{
        id: 'smoke-expand-result',
        providerId: 'smoke',
        title: 'Spotlight smoke',
      }],
    }]);
    assert(modal._rows.length > 0, step, 'no rows after typing the first character');

    step = 'space-types';
    const spacePropagates = pressKey(modal, Clutter.KEY_space);
    assert(spacePropagates === Clutter.EVENT_PROPAGATE, step,
      'plain Space was consumed instead of reaching the entry');
    modal._entry.set_text('spot light');
    assert(modal._entry.get_text() === 'spot light', step,
      `entry text is ${JSON.stringify(modal._entry.get_text())}, expected "spot light"`);

    step = 'modal-typed';
    modal._entry.set_text('spo');
    const text = modal._entry.get_text();
    assert(text.length === 3, step, `entry text is ${JSON.stringify(text)}, expected 3 characters`);

    step = 'preview-text';
    // Keep the smoke deterministic: the isolated session may have no `locate`
    // index, so feed the modal a real file result after the query was typed.
    modal._cancelSearch();
    const smokePath = GLib.filename_from_uri(import.meta.url)[0];
    const previewPath = GLib.build_filenamev([
      GLib.path_get_dirname(
        GLib.path_get_dirname(GLib.path_get_dirname(smokePath))
      ),
      'metadata.json',
    ]);
    const fileResult = {
      id: previewPath,
      providerId: 'files',
      title: 'metadata.json',
      subtitle: previewPath,
      kind: 'json',
      icon: 'text-x-generic-symbolic',
      actions: { primary: () => {} },
      preview: {
        path: previewPath,
        rows: [
          ['Ścieżka', previewPath],
          ['Typ', 'json'],
        ],
        description: previewPath,
      },
    };
    modal._setCompact(false);  // kompakt startuje bez listy wyników
    modal.setResults([{ id: 'files', title: 'Pliki', results: [fileResult] }]);
    assert(modal._rows.length === 1, step, 'file result was not added');
    assert(modal._selectedResult() === fileResult, step, 'file result is not selected');

    const preview = modal._preview;

    step = 'preview-hidden-default';
    assert(preview && preview.visible === false, step,
      'preview sidebar is visible before Ctrl+Space');
    assert(modal._previewVisible === false, step,
      'preview visibility state is not reset on a new query');
    await waitFor(
      () => modal.width > 0 &&
        modal._body.width >= modal.width - 4 &&
        modal._results.width === modal._body.width,
      'result list to occupy the full modal width while the sidebar is hidden'
    );

    step = 'preview-sidebar-toggle';
    const plainPreviewEvent = pressKey(modal, Clutter.KEY_space);
    assert(plainPreviewEvent === Clutter.EVENT_PROPAGATE, step,
      'plain Space was consumed instead of typing a space');
    assert(preview.isPreviewOpen() === false, step, 'plain Space opened the preview');

    const previewEvent = pressKey(
      modal,
      Clutter.KEY_space,
      Clutter.ModifierType.CONTROL_MASK
    );
    assert(previewEvent === Clutter.EVENT_STOP, step,
      'Ctrl+Space did not open the text preview');
    assert(modal._previewVisible === true, step,
      'Ctrl+Space did not mark the sidebar as visible');
    assert(preview.visible === true, step,
      'Ctrl+Space did not show the preview sidebar');
    assert(preview._model, step, 'Ctrl+Space did not fill the preview model');
    assert(preview.isPreviewOpen() === true, step,
      'Ctrl+Space did not mark the text preview as open');

    step = 'preview-text';
    await waitFor(
      () => preview._textScroll.visible &&
        preview._textLabel.get_text().length > 0 &&
        preview._textScroll.height > 0,
      'text preview to be visible with non-zero height'
    );
    assert(preview.height > 0, step, `preview panel height is ${preview.height}`);
    assert(preview._textScroll.height > 0, step, 'text preview has zero height');
    assert(modal._results.width < modal._body.width, step,
      'result list did not shrink to make room for the preview sidebar');

    // Ctrl+Space again hides the sidebar and returns the list to full width;
    // it does not close the modal.
    step = 'preview-sidebar-toggle';
    const closeTextEvent = pressKey(
      modal,
      Clutter.KEY_space,
      Clutter.ModifierType.CONTROL_MASK
    );
    assert(closeTextEvent === Clutter.EVENT_STOP, step,
      'Ctrl+Space did not close the preview sidebar');
    assert(modal._previewVisible === false, step,
      'the second Ctrl+Space did not hide the sidebar state');
    assert(preview.visible === false, step, 'preview sidebar is still visible');
    assert(preview.isPreviewOpen() === false, step, 'text preview is still marked open');
    assert(preview._textScroll.visible === false, step, 'text preview is still visible');
    await waitFor(
      () => modal._results.width === modal._body.width,
      'result list to return to the full modal width'
    );

    step = 'preview-image';
    const imagePath = writeSmokePng();
    const imageResult = {
      id: imagePath,
      providerId: 'files',
      title: 'spotlight-smoke.png',
      subtitle: imagePath,
      kind: 'png',
      icon: 'image-x-generic-symbolic',
      actions: { primary: () => {} },
      preview: {
        path: imagePath,
        rows: [
          ['Ścieżka', imagePath],
          ['Typ', 'png'],
        ],
        description: imagePath,
      },
    };
    modal._setCompact(false);  // kompakt startuje bez listy wyników
    modal.setResults([{ id: 'files', title: 'Pliki', results: [imageResult] }]);
    assert(modal._rows.length === 1, step, 'image result was not added');
    assert(modal._selectedResult() === imageResult, step, 'image result is not selected');

    const imageEvent = pressKey(
      modal,
      Clutter.KEY_space,
      Clutter.ModifierType.CONTROL_MASK
    );
    assert(imageEvent === Clutter.EVENT_STOP, step,
      'Ctrl+Space did not open the image preview');

    await waitFor(
      () => {
        const child = preview._imageBox.get_child();
        return preview._imageBox.visible &&
          child &&
          typeof child.get_preferred_height === 'function' &&
          child.get_preferred_height(-1)[1] > 0;
      },
      'image preview to expose a non-empty image child'
    );
    const imageChild = preview._imageBox.get_child();
    assert(imageChild.get_preferred_height(-1)[1] > 0, step, 'image child has zero height');
    assert(preview._textScroll.visible === false, step, 'text box is visible over the image');

    step = 'modal-esc';
    const previewEscape = pressEscape(modal);
    assert(previewEscape === Clutter.EVENT_STOP, step, 'Escape was not consumed by the preview');
    assert(modal.isOpen === true, step, 'the first Escape closed the modal instead of the preview');
    assert(preview.isPreviewOpen() === false, step, 'image preview is still open after Escape');
    assert(preview._imageBox.visible === false, step, 'image preview is still visible after Escape');

    const result = pressEscape(modal);
    assert(result === Clutter.EVENT_STOP, step, 'Escape was not consumed by the modal');
    assert(modal.isOpen === false, step, 'modal is still open after Escape');
    assert(modal.visible === false, step, 'modal is still visible after Escape');

    step = 'action-menu';
    extension.stateObj._toggle();
    assert(modal.isOpen === true, step, 'modal did not reopen for the action menu');
    modal._cancelSearch();
    const actionResult = {
      id: 'smoke-actions',
      providerId: 'smoke',
      title: 'SMOKE MENU',
      subtitle: 'deskryptory akcji',
      kind: 'Test',
      icon: 'application-x-executable-symbolic',
      actions: JSON.stringify({
        primary: {
          id: 'launch',
          label: 'Uruchom',
          type: 'app',
          appId: 'org.gnome.Settings',
        },
        secondary: {
          id: 'copy-path',
          label: 'Kopiuj ścieżkę',
          type: 'copy',
          text: 'SMOKE MENU',
        },
        menu: [
          {
            id: 'launch',
            label: 'Uruchom',
            type: 'app',
            appId: 'org.gnome.Settings',
          },
          {
            id: 'copy-path',
            label: 'Kopiuj ścieżkę',
            type: 'copy',
            text: 'SMOKE MENU',
          },
        ],
      }),
      preview: {
        rows: [
          ['Akcje', '2'],
          ['Typ', 'deskryptory'],
        ],
      },
    };
    modal._setCompact(false);  // kompakt startuje bez listy wyników
    modal.setResults([{ id: 'smoke', title: 'Smoke', results: [actionResult] }]);
    assert(modal._selectedResult() === actionResult, step, 'action result is not selected');

    // The sidebar is hidden by default; open it so its Akcje button has the
    // action-menu callback installed by _updatePreview().
    const actionPreviewEvent = pressKey(
      modal,
      Clutter.KEY_space,
      Clutter.ModifierType.CONTROL_MASK
    );
    assert(actionPreviewEvent === Clutter.EVENT_STOP, step,
      'Ctrl+Space did not open the preview for the action menu check');
    assert(modal._preview.visible === true, step,
      'preview sidebar is not visible for the action menu check');

    // Clutter only delivers pointer events to reactive actors; a non-reactive
    // St.Button must not turn a release into a click.
    const inertButton = new St.Button({ reactive: false, can_focus: true });
    let inertClicks = 0;
    inertButton.connect('clicked', () => {
      inertClicks++;
    });
    inertButton.fake_release();
    assert(inertClicks === 0, step, 'reactive:false St.Button emitted clicked');
    inertButton.destroy();

    // The preview's Akcje button must therefore be reactive and wired to the
    // menu callback.
    const secondaryButton = modal._preview?._secondaryButton;
    assert(secondaryButton?.reactive === true, step, 'preview Akcje button is not reactive');
    assert(
      modal._preview?._secondaryLabel?.get_text?.() === 'Akcje ⌃K',
      step,
      'preview Akcje button label is not "Akcje ⌃K"'
    );
    // StButton::clicked niesie jeden argument (kliknięty aktor).
    secondaryButton.emit('clicked', secondaryButton);
    const buttonMenu = modal._actionMenu;
    assert(buttonMenu, step, 'preview Akcje button did not open the action menu');
    assert(
      actionMenuItems(buttonMenu).length >= 2,
      step,
      'preview Akcje button opened a menu with fewer than two items'
    );
    modal._closeActionMenu();

    const menuKey = pressKey(modal, Clutter.KEY_k, Clutter.ModifierType.CONTROL_MASK);
    assert(menuKey === Clutter.EVENT_STOP, step, 'Ctrl+K was not consumed');
    const menu = modal._actionMenu;
    assert(menu, step, 'Ctrl+K did not open the action menu');

    step = 'action-menu-anchored';
    assert(menu.sourceActor === modal._selectedRow(), step,
      'Ctrl+K anchored the action menu to something other than the selected row');

    const menuItems = actionMenuItems(menu);
    assert(menuItems.length >= 2, step,
      `action menu has ${menuItems.length} items, expected at least 2`);
    assert(menuItems[0].sensitive === true, step,
      'first action menu item is not sensitive');
    modal._closeActionMenu();

    step = 'action-menu-rightclick';
    const secondActionResult = {
      ...actionResult,
      id: 'smoke-actions-2',
      title: 'SMOKE MENU 2',
    };
    modal._setCompact(false);  // kompakt startuje bez listy wyników
    modal.setResults([{
      id: 'smoke',
      title: 'Smoke',
      results: [actionResult, secondActionResult],
    }]);
    assert(modal._rows.length === 2, step,
      `expected two rows for the right-click check, got ${modal._rows.length}`);
    const clickedRow = modal._rows[1];
    const fakeEvent = { get_button: () => 3 };
    clickedRow.emit('context-menu', clickedRow, fakeEvent);
    assert(modal._selectedIndex === 1, step,
      `right-click did not select the clicked row (index ${modal._selectedIndex})`);
    assert(modal._actionMenu?.sourceActor === clickedRow, step,
      'right-click action menu is not anchored to the clicked row');
    modal._closeActionMenu();

    step = 'tab-sections';
    const firstSectionResult = {
      id: 'smoke-section-a',
      providerId: 'smoke-a',
      title: 'Sekcja A',
    };
    const secondSectionResult = {
      id: 'smoke-section-b',
      providerId: 'smoke-b',
      title: 'Sekcja B',
    };
    modal._setCompact(false);  // kompakt startuje bez listy wyników
    modal.setResults([
      { id: 'smoke-a', title: 'Sekcja A', results: [firstSectionResult] },
      { id: 'smoke-b', title: 'Sekcja B', results: [secondSectionResult] },
    ]);
    assert(modal._sections.length === 2, step,
      `expected two sections, got ${modal._sections.length}`);
    assert(modal._selectedIndex === 0, step,
      `expected selection in the first section, got ${modal._selectedIndex}`);
    const tab = pressKey(modal, Clutter.KEY_Tab);
    assert(tab === Clutter.EVENT_STOP, step, 'Tab was not consumed');
    assert(modal._selectedIndex === modal._sections[1].firstIndex, step,
      `Tab did not move to the second section (index ${modal._selectedIndex})`);

    const singleSectionResult = {
      id: 'smoke-section-c',
      providerId: 'smoke-c',
      title: 'Sekcja C',
    };
    modal._setCompact(false);  // kompakt startuje bez listy wyników
    modal.setResults([{
      id: 'smoke-c',
      title: 'Sekcja C',
      results: [firstSectionResult, singleSectionResult],
    }]);
    assert(modal._sections.length === 1, step,
      `expected one section, got ${modal._sections.length}`);
    assert(modal._selectedIndex === 0, step,
      `expected selection at the first row, got ${modal._selectedIndex}`);
    const singleTab = pressKey(modal, Clutter.KEY_Tab);
    assert(singleTab === Clutter.EVENT_STOP, step, 'Tab was not consumed in one section');
    assert(modal._selectedIndex === 1, step,
      `Tab in one section did not move by one (index ${modal._selectedIndex})`);

    step = 'scroll-overflow';
    const originalLimit = modal._options.limit;
    modal._options.limit = 40;
    modal._setCompact(false);
    modal.setResults(smokeResults(25, 'overflow'));
    await sleep(50);
    const resultsScroll = modal._resultsScroll;
    assert(resultsScroll, step, 'modal has no St.ScrollView for the result list');
    assert(resultsScroll.hscrollbar_policy === St.PolicyType.NEVER, step,
      'result scroll view allows a horizontal scrollbar');
    assert(resultsScroll.vscrollbar_policy === St.PolicyType.AUTOMATIC, step,
      'result scroll view does not use automatic vertical scrolling');
    assert(resultsScroll.enable_mouse_scrolling === true, step,
      'result scroll view has mouse scrolling disabled');
    assert(
      resultsScroll.overlay_scrollbars === false ||
        resultsScroll.overlay_scrolling === false,
      step,
      'result scroll view uses overlay scrolling'
    );

    const scrollAdjustment = resultsScroll.vadjustment;
    await waitFor(
      () => resultsScroll.height > 0 &&
        scrollAdjustment.page_size > 0 &&
        scrollAdjustment.upper > scrollAdjustment.page_size,
      'result list scroll overflow to be allocated'
    );
    assert(scrollAdjustment.value === 0, step,
      `scroll starts at ${scrollAdjustment.value}, expected 0`);
    const scrollMonitor = modal._getMonitor();
    assert(
      resultsScroll.height <= Math.ceil(scrollMonitor.height * 0.6),
      step,
      `scroll height ${resultsScroll.height} exceeds 60% of monitor ` +
        `${scrollMonitor.height}`
    );
    const scrollWorkArea = Main.layoutManager.getWorkAreaForMonitor(
      modal._getMonitorIndex()
    );
    assert(
      modal.y + modal.height <= scrollWorkArea.y + scrollWorkArea.height + 1,
      step,
      'modal overflows the monitor work area'
    );

    step = 'scroll-keyboard';
    modal.setResults(smokeResults(20, 'keyboard'));
    await sleep(50);
    await waitFor(
      () => scrollAdjustment.upper > scrollAdjustment.page_size &&
        scrollAdjustment.value === 0 &&
        modal._rows[0]?.height > 0,
      'keyboard scroll list to be allocated'
    );
    for (let i = 0; i < 12; i++)
      pressKey(modal, Clutter.KEY_Down);
    await waitFor(
      () => scrollAdjustment.value > 0,
      'arrow keys to scroll the selected row into view'
    );
    const keyboardRow = modal._rows[modal._selectedIndex];
    const keyboardOffset = modal._rowOffset(keyboardRow);
    assert(
      keyboardOffset >= scrollAdjustment.value &&
        keyboardOffset <= scrollAdjustment.value + scrollAdjustment.page_size,
      step,
      `selected row offset ${keyboardOffset} is outside the visible ` +
        `[${scrollAdjustment.value}, ` +
        `${scrollAdjustment.value + scrollAdjustment.page_size}] range`
    );

    step = 'scroll-wheel';
    modal.setResults(smokeResults(25, 'wheel'));
    await sleep(50);
    await waitFor(
      () => scrollAdjustment.upper > scrollAdjustment.page_size &&
        scrollAdjustment.value === 0,
      'wheel scroll list to be allocated'
    );
    const wheelIndex = modal._selectedIndex;
    const wheelValue = scrollAdjustment.value;
    const wheelEvent = {
      type: () => Clutter.EventType.SCROLL,
      get_scroll_direction: () => Clutter.ScrollDirection.DOWN,
      get_scroll_delta: () => [0, 0],
      get_state: () => 0,
    };
    // `emit()` na GObject wymaga prawdziwego Clutter.Event (boxed type); w smoke
    // nie da się go skonstruować, więc wołamy handler bezpośrednio.
    const wheelHandled = modal._onResultsScroll(resultsScroll, wheelEvent);
    assert(wheelHandled === Clutter.EVENT_STOP, step,
      'scroll-down event was not consumed by the result list');
    await waitFor(
      () => scrollAdjustment.value > wheelValue,
      'mouse wheel to change the vertical adjustment'
    );
    assert(modal._selectedIndex === wheelIndex, step,
      `mouse wheel changed the selection from ${wheelIndex} to ` +
        `${modal._selectedIndex}`);
    modal._options.limit = originalLimit;

    step = 'blur-off-default';
    assert(modal._panelBlurClone === null, step,
      'blur clone exists before blur-enabled was turned on');
    assert(modal._panelBlurActor === null, step,
      'blur container exists before blur-enabled was turned on');
    assert(modal._panelBlurLayer === null, step,
      'blur layer exists before blur-enabled was turned on');
    assert(modal._panelBlurMask === null, step,
      'blur mask exists before blur-enabled was turned on');

    step = 'blur-height-stable';
    await waitFor(
      () => modal.height > 0 &&
        modal._panel.height > 0 &&
        modal._body.height > 0,
      'panel layout before enabling blur'
    );
    const heightWithoutBlur = modal.height;
    const panelHeightWithoutBlur = modal._panel.height;
    const contentHeightWithoutBlur = expectedPanelContentHeight(modal);
    assert(
      Math.abs(panelHeightWithoutBlur - contentHeightWithoutBlur) <= 2,
      step,
      `blur-off panel height ${panelHeightWithoutBlur} differs from ` +
        `content height ${contentHeightWithoutBlur}`
    );

    step = 'blur-applied';
    const modalSettings = extension.stateObj._settings;
    assert(modalSettings, step, 'extension settings are unavailable');
    modalSettings.set_int('blur-radius', 32);
    modalSettings.set_boolean('blur-enabled', true);

    const backgroundGroup = Main.layoutManager?._backgroundGroup ?? null;
    await initBmsBlur();
    if (!bmsBlurAvailable() || !backgroundGroup || !global.window_group) {
      blurCloneAvailable = false;
      await waitFor(
        () => modal._panelBlurClone === null && modal._panelBlurActor === null,
        'translucent fallback with blur-enabled on an unavailable backend'
      );
      const reason = !bmsBlurAvailable()
        ? 'Blur my Shell unavailable'
        : !backgroundGroup
          ? 'background group unavailable'
          : 'window group unavailable';
      print(`SKIP: blur-clone (${reason})`);
    } else {
      const blurClone = await waitFor(
        () => modal._panelBlurClone,
        'panel background clone'
      );
      const blurLayer = await waitFor(
        () => modal._panelBlurLayer,
        'panel blur layer'
      );
      const blurEffect = modal._panelBlurEffect ?? null;
      assert(blurEffect, step, 'panel backdrop has no Blur my Shell effect');
      assert(Number(blurEffect.unscaled_radius) === 32, step,
        `panel blur unscaled_radius is ${blurEffect.unscaled_radius}, expected 32`);
      assert(blurClone.visible === true, step, 'panel blur clone is hidden');
      assert(modal._panelBlurActor?.visible === true, step,
        'panel backdrop container is hidden');
      assert(modal._panelBlurActor.get_parent() === modal._panel, step,
        'panel backdrop container is not inside the modal actor tree');
      assert(modal._panelBlurActor.get_child_at_index?.(0) ===
        modal._panelBlurHost, step,
        'blur host is not the first backdrop child');
      assert(modal._panelBlurHost.get_child_at_index?.(0) ===
        modal._panelBlurClone, step,
        'background clone is not the first blur-host child');
      assert(modal._panelBlurVeil, step, 'panel blur veil is missing');
      assert(modal._panelBlurVeil.get_parent() === modal._panelBlurActor, step,
        'panel blur veil is not inside the masked backdrop');
      assert(modal._panelBlurActor.get_child_at_index?.(1) ===
        modal._panelBlurVeil, step,
        'panel blur veil is not above the blurred clones');

      step = 'veil-rounded';
      // The veil is a plain tint rounded by CSS border-radius (the BMS blur
      // rounds the clones itself); it must carry a radius, not a square edge.
      const veilStyle = String(modal._panelBlurVeil.get_style?.() ?? '');
      assert(veilStyle.includes('border-radius'), step,
        'panel blur veil is not rounded via border-radius');
      assert(veilStyle.includes('border: '), step,
        'panel blur veil has no delicate border');

      step = 'blur-layers';
      const layerChildren = blurLayer.get_children?.() ?? [];
      const layerClones = descendantActors(blurLayer).filter(child =>
        typeof child?.get_source === 'function'
      );
      assert(layerChildren.length === 2, step,
        `panel blur layer has ${layerChildren.length} children, ` +
          'expected blur host + veil');
      assert(layerClones.length === 2, step,
        `panel blur layer has ${layerClones.length} clones, expected 2`);
      assert(layerChildren[0] === modal._panelBlurHost, step,
        'first layer child is not the blur host');
      assert(modal._panelBlurClone.get_parent() === modal._panelBlurHost, step,
        'background clone is not inside the blur host');
      const sources = cloneSources(blurLayer);
      const backgroundSource = sources[0];
      assert(
        backgroundSource === backgroundGroup ||
          backgroundSource?.get_parent?.() === backgroundGroup,
        step,
        'first panel blur clone does not clone the Shell background group'
      );
      assert(!sources.some(source =>
        source === Main.uiGroup ||
        source === global.stage ||
        source === modal ||
        source === modal._panel ||
        source === blurLayer
      ), step, 'panel blur clones contain the panel/UI group itself');
      assert(blurClone.x < 0 && blurClone.y < 0, step,
        `panel blur clone offset is not negative (${blurClone.x}, ${blurClone.y})`);

      step = 'blur-window-clone';
      assert(modal._panelBlurWindowClone, step,
        'panel blur has no window-group clone');
      assert(layerClones[1]?.source === global.window_group, step,
        'second panel blur clone does not clone global.window_group');
      assert(modal._panelBlurWindowClone.source === global.window_group, step,
        'window clone source is not global.window_group');
      assert(modal._panelBlurWindowClone.x < 0 &&
        modal._panelBlurWindowClone.y < 0, step,
        'window clone offset is not negative');

      step = 'blur-effect';
      // The BMS blur sits on the inner host and rounds its own corners; the
      // outer container carries no mask (the retired offscreen rounded mask
      // mis-sampled the panel texture in GNOME 51).
      const layerEffects = modal._panelBlurActor?.get_effects?.() ?? [];
      const hostEffects = modal._panelBlurHost?.get_effects?.() ?? [];
      assert(layerEffects.length === 0, step,
        `backdrop container has ${layerEffects.length} effects, expected 0`);
      assert(hostEffects.length === 1, step,
        `blur host has ${hostEffects.length} effects, expected 1 (blur)`);
      assert(hostEffects[0] === modal._panelBlurEffect, step,
        'blur host effect is not the referenced Blur my Shell effect');

      step = 'blur-corner-radius';
      const cornerRadius = Number(modal._panelBlurEffect?.corner_radius);
      assert(cornerRadius === 18, step,
        `blur corner_radius is ${cornerRadius}, expected 18`);

      step = 'blur-height-stable';
      await waitFor(
        () => Math.abs(modal.height - heightWithoutBlur) <= 2,
        'panel height to stay stable after enabling blur'
      );
      assert(Math.abs(modal.height - heightWithoutBlur) <= 2, step,
        `modal height ${modal.height} differs from blur-off ` +
          `${heightWithoutBlur}`);
      assert(
        Math.abs(modal._panel.height - panelHeightWithoutBlur) <= 2,
        step,
        `panel height ${modal._panel.height} differs from blur-off ` +
          `${panelHeightWithoutBlur}`
      );
      const contentHeight = expectedPanelContentHeight(modal);
      assert(Math.abs(modal._panel.height - contentHeight) <= 2, step,
        `panel height ${modal._panel.height} differs from content ` +
          `${contentHeight}`);

      // Live radius changes must reach the existing effect, without reopening
      // the modal or rebuilding the actor tree.
      modalSettings.set_int('blur-radius', 40);
      await waitFor(
        () => Number(modal._panelBlurEffect?.unscaled_radius) === 40,
        'live blur radius update'
      );
      modalSettings.set_int('blur-radius', 32);
      await waitFor(
        () => Number(modal._panelBlurEffect?.unscaled_radius) === 32,
        'blur radius restored to 32'
      );
    }

    // Turning the setting off must remove the clones, effects and mask
    // entirely, not just hide the actors.
    step = 'blur-teardown';
    modalSettings.set_boolean('blur-enabled', false);
    await waitFor(
      () => modal._panelBlurClone === null &&
        modal._panelBlurActor === null &&
        modal._panelBlurLayer === null &&
        modal._panelBlurMask === null,
      'blur actor removal after blur-enabled=false'
    );
    assert(modal._panelBlurEffect === null, step,
      'blur effect reference survived blur-enabled=false');
    assert(modal._panelBlurWindowClone === null, step,
      'window clone reference survived blur-enabled=false');
    assert(cloneSources(modal).length === 0, step,
      'blur clones leaked after blur-enabled=false');
    assert(actorEffects(modal).length === 0, step,
      'blur effects leaked after blur-enabled=false');

    modal.close();

    step = 'activate-copy';
    extension.stateObj._toggle();
    assert(modal.isOpen === true, step, 'modal did not reopen for the activation check');
    modal._cancelSearch();
    const copyResult = {
      id: 'smoke-copy',
      providerId: 'smoke',
      title: 'SMOKE-42',
      subtitle: 'akcja deklaratywna',
      kind: 'Test',
      icon: 'edit-copy-symbolic',
      // The daemon sends actions as a JSON string; use the same shape so the
      // smoke exercises parseActions + runAction, not a local callback.
      actions: JSON.stringify({
        primary: {
          id: 'copy-smoke',
          label: 'Kopiuj',
          type: 'copy',
          text: 'SMOKE-42',
        },
        secondary: null,
        menu: [],
      }),
    };
    modal._setCompact(false);  // kompakt startuje bez listy wyników
    modal.setResults([{ id: 'smoke', title: 'Smoke', results: [copyResult] }]);
    assert(modal._selectedResult() === copyResult, step, 'copy result is not selected');

    const copyEnter = modal._onCapturedEvent(modal, {
      type: () => Clutter.EventType.KEY_PRESS,
      get_key_symbol: () => Clutter.KEY_Return,
      get_state: () => 0,
    });
    assert(copyEnter === Clutter.EVENT_STOP, step, 'Enter was not consumed');
    await waitForClipboard('SMOKE-42', 'clipboard to contain SMOKE-42');
    assert(modal.isOpen === false, step, 'modal is still open after activation');

    step = 'activate-dbus';
    if (await ensureDaemon()) {
      const rawResult = await actionableDaemonResult();
      if (rawResult) {
        // Same path as Enter: daemon a{sv} -> DaemonClient normalization ->
        // searchStream normalization -> parseActions in _activateResult().
        const daemonResult = normalizeDaemonResult(rawResult);
        assert(daemonResult, step, 'D-Bus result did not normalize');
        normalizeResultActions(daemonResult);

        const actions = parseActions(daemonResult);
        assert(
          actions.primary?.type !== null &&
            actions.primary?.type !== undefined &&
            String(actions.primary.type) !== '',
          step,
          `parseActions(result).primary.type is ${JSON.stringify(actions.primary?.type ?? null)}`
        );

        // A raw a{sv} keeps its values as Variants after deep_unpack; the
        // regression is only covered when the raw dict is passed in too.
        const rawActions = parseActions(rawResult);
        assert(rawActions.primary?.type, step,
          'raw Variant actions did not parse to a primary action');
        dbusActivation = true;
      } else {
        print('SKIP: activate-dbus (daemon nie zwrócił wyniku z akcją)');
      }
    } else {
      print('SKIP: activate-dbus (daemon niedostępny)');
    }

    step = 'modal-closed';
    Main.extensionManager.disableExtension(COEXIST_UUID);
    Main.extensionManager.disableExtension(UUID);
    await waitFor(
      () => {
        const primary = extensionState(UUID);
        const secondary = extensionState(COEXIST_UUID);
        return primary && secondary &&
          primary.state !== ExtensionState.ACTIVE &&
          secondary.state !== ExtensionState.ACTIVE
          ? { primary, secondary }
          : null;
      },
      'both extensions to leave ACTIVE'
    );

    // Keep the five-marker line for older local smoke wrappers; the canonical
    // marker contract (including window-actions and preview-image) is printed
    // last. activate-dbus is only claimed when the real D-Bus path ran.
    let markers = dbusActivation
      ? MARKERS
      : MARKERS.filter(marker => marker !== 'activate-dbus');
    if (!blurCloneAvailable) {
      const unavailableMarkers = new Set([
        'blur-clone',
        'blur-applied',
        'blur-layers',
        'blur-window-clone',
        'blur-height-stable',
        'blur-mask-effect',
        'blur-mask-radius',
        'blur-teardown',
        'veil-rounded',
      ]);
      markers = markers.filter(marker => !unavailableMarkers.has(marker));
      markers.push('blur-unavailable');
    }
    print('PASS: modal-open modal-typed modal-esc modal-closed preview-text');
    print(`PASS: ${markers.join(' ')}`);
  } catch (error) {
    print(`FAIL: ${step}: ${error.message}`);
    throw error;
  } finally {
    stopDaemon();
  }
}