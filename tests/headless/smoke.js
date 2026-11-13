import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { ExtensionState } from 'resource:///org/gnome/shell/misc/extensionUtils.js';

import { parseActions } from '../../lib/action-runner.js';
import { normalizeDaemonResult } from '../../lib/daemonClient.js';
import { normalizeResultActions } from '../../lib/searchStream.js';
import { planTile } from '../../lib/window-actions.js';

const UUID = 'spotlight@haniewicz.dev';
const COEXIST_UUID = `${UUID}-coexist`;
const DAEMON_BUS_NAME = 'org.gnome.Spotlight';
const DAEMON_OBJECT_PATH = '/org/gnome/Spotlight/Search';
const DAEMON_SEARCH_INTERFACE = 'org.gnome.Spotlight.Search';
const DAEMON_SEARCH_REPLY = '(aa{sv}s)';
const MARKERS = [
  'window-actions',
  'modal-open',
  'modal-typed',
  'modal-esc',
  'modal-closed',
  'preview-text',
  'preview-image',
  'clipboard-item',
  'action-menu',
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
    St.Clipboard.get_default().set_text(
      St.ClipboardType.CLIPBOARD,
      clipboardText
    );
    extension.stateObj._toggle();
    const modal = extension.stateObj._modal;
    assert(modal, step, 'modal was not created');
    assert(modal.isOpen === true, step, 'keybinding handler did not open the modal');
    assert(modal.visible === true, step, 'modal is not visible');

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
    modal.setResults([{ id: 'files', title: 'Pliki', results: [fileResult] }]);
    assert(modal._rows.length === 1, step, 'file result was not added');
    assert(modal._selectedResult() === fileResult, step, 'file result is not selected');

    const preview = modal._preview;
    assert(preview && preview.visible === true, step, 'preview panel is not visible');

    const previewEvent = modal._onCapturedEvent(modal, {
      type: () => Clutter.EventType.KEY_PRESS,
      get_key_symbol: () => Clutter.KEY_space,
      get_state: () => 0,
    });
    assert(previewEvent === Clutter.EVENT_STOP, step, 'Space did not open the text preview');

    await waitFor(
      () => preview._textScroll.visible &&
        preview._textLabel.get_text().length > 0 &&
        preview._textScroll.height > 0,
      'text preview to be visible with non-zero height'
    );
    assert(preview.height > 0, step, `preview panel height is ${preview.height}`);
    assert(preview._textScroll.height > 0, step, 'text preview has zero height');

    // Space again returns to the metadata/list view instead of closing the
    // modal; this is the Quick Look toggle contract.
    const closeTextEvent = modal._onCapturedEvent(modal, {
      type: () => Clutter.EventType.KEY_PRESS,
      get_key_symbol: () => Clutter.KEY_space,
      get_state: () => 0,
    });
    assert(closeTextEvent === Clutter.EVENT_STOP, step, 'Space did not close the text preview');
    assert(preview.isPreviewOpen() === false, step, 'text preview is still marked open');
    assert(preview._textScroll.visible === false, step, 'text preview is still visible');

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
    modal.setResults([{ id: 'files', title: 'Pliki', results: [imageResult] }]);
    assert(modal._rows.length === 1, step, 'image result was not added');
    assert(modal._selectedResult() === imageResult, step, 'image result is not selected');

    const imageEvent = modal._onCapturedEvent(modal, {
      type: () => Clutter.EventType.KEY_PRESS,
      get_key_symbol: () => Clutter.KEY_space,
      get_state: () => 0,
    });
    assert(imageEvent === Clutter.EVENT_STOP, step, 'Space did not open the image preview');

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
    modal.setResults([{ id: 'smoke', title: 'Smoke', results: [actionResult] }]);
    assert(modal._selectedResult() === actionResult, step, 'action result is not selected');

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
    secondaryButton.emit('clicked');
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
    const menuItems = actionMenuItems(menu);
    assert(menuItems.length >= 2, step,
      `action menu has ${menuItems.length} items, expected at least 2`);
    assert(menuItems[0].sensitive === true, step,
      'first action menu item is not sensitive');
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
    const markers = dbusActivation
      ? MARKERS
      : MARKERS.filter(marker => marker !== 'activate-dbus');
    print('PASS: modal-open modal-typed modal-esc modal-closed preview-text');
    print(`PASS: ${markers.join(' ')}`);
  } catch (error) {
    print(`FAIL: ${step}: ${error.message}`);
    throw error;
  } finally {
    stopDaemon();
  }
}