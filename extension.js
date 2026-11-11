import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import { SpotlightModal } from './lib/ui/modal.js';

export default class SpotlightExtension extends Extension {
  constructor(metadata) {
    super(metadata);
    this._settings = null;
    this._modal = null;
    this._enabled = false;
  }

  enable() {
    if (this._enabled)
      return;

    this._settings = this.getSettings();
    this._modal = new SpotlightModal(this._settings);

    Main.wm.addKeybinding(
      'toggle-keybinding',
      this._settings,
      Meta.KeyBindingFlags.NONE,
      Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
      () => this._toggle()
    );

    this._enabled = true;
  }

  _toggle() {
    if (this._modal)
      this._modal.toggle();
  }

  disable() {
    this._enabled = false;

    // Unconditional and guarded: disable() must never throw, even when
    // called twice or after a failed enable().
    try {
      Main.wm.removeKeybinding('toggle-keybinding');
    } catch (error) {
      logError(error);
    }

    if (this._modal) {
      try {
        this._modal.destroy();
      } catch (error) {
        logError(error);
      }
      this._modal = null;
    }

    this._settings = null;
  }
}