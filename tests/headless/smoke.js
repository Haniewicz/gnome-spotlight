import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { ExtensionState } from 'resource:///org/gnome/shell/misc/extensionUtils.js';

const UUID = 'spotlight@haniewicz.dev';
const MARKERS = ['modal-open', 'modal-typed', 'modal-esc', 'modal-closed'];

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
 * Sequence: enable -> keybinding handler -> modal visible -> type "spo" ->
 * entry has 3 chars -> Escape -> modal hidden -> disable.
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

    step = 'modal-esc';
    const result = pressEscape(modal);
    assert(result === Clutter.EVENT_STOP, step, 'Escape was not consumed by the modal');
    assert(modal.isOpen === false, step, 'modal is still open after Escape');
    assert(modal.visible === false, step, 'modal is still visible after Escape');

    step = 'modal-closed';
    Main.extensionManager.disableExtension(UUID);
    await waitFor(
      () => {
        const candidate = extensionState();
        return candidate && candidate.state !== ExtensionState.ACTIVE ? candidate : null;
      },
      `extension ${UUID} to leave ACTIVE`
    );

    print(`PASS: ${MARKERS.join(' ')}`);
  } catch (error) {
    print(`FAIL: ${step}: ${error.message}`);
    throw error;
  }
}