import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { ExtensionState } from 'resource:///org/gnome/shell/misc/extensionUtils.js';

const UUID = 'spotlight@haniewicz.dev';
const COEXIST_UUID = `${UUID}-coexist`;
const MARKERS = [
  'modal-open',
  'modal-typed',
  'modal-esc',
  'modal-closed',
  'preview-text',
  'preview-image',
];

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

/**
 * Headless smoke script run by gnome-shell --automation-script.
 *
 * Sequence: enable primary -> enable second copy with another UUID -> both
 * ACTIVE -> keybinding handler -> modal visible -> type "spo" -> entry has
 * 3 chars -> Escape -> modal hidden -> disable both.
 */
export async function run() {
  let step = 'enable';
  try {
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
    extension.stateObj._toggle();
    const modal = extension.stateObj._modal;
    assert(modal, step, 'modal was not created');
    assert(modal.isOpen === true, step, 'keybinding handler did not open the modal');
    assert(modal.visible === true, step, 'modal is not visible');

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
    // six-marker contract (including preview-image) is printed last.
    print('PASS: modal-open modal-typed modal-esc modal-closed preview-text');
    print(`PASS: ${MARKERS.join(' ')}`);
  } catch (error) {
    print(`FAIL: ${step}: ${error.message}`);
    throw error;
  }
}