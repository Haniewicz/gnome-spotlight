import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import { SpotlightModal } from './lib/ui/modal.js';
import { ProviderRegistry } from './lib/providers/registry.js';
import { createProvider as createAppsProvider } from './lib/providers/apps.js';
import { createProvider as createWindowsProvider } from './lib/providers/windows.js';
import { createProvider as createSettingsProvider } from './lib/providers/settings.js';
import { createProvider as createCommandsProvider } from './lib/providers/commands.js';

// Card 2 providers. Files and calculator join this map in card 3.
const PROVIDER_FACTORIES = {
  apps: createAppsProvider,
  windows: createWindowsProvider,
  settings: createSettingsProvider,
  commands: createCommandsProvider,
};

export default class SpotlightExtension extends Extension {
  constructor(metadata) {
    super(metadata);
    this._settings = null;
    this._modal = null;
    this._registry = null;
    this._providersChangedId = 0;
    this._enabled = false;
  }

  enable() {
    if (this._enabled)
      return;

    this._settings = this.getSettings();
    this._registry = new ProviderRegistry();
    this._syncProviders();

    this._modal = new SpotlightModal(this._settings, {
      registry: this._registry,
    });

    this._providersChangedId = this._settings.connect(
      'changed::enabled-providers',
      () => this._syncProviders()
    );

    Main.wm.addKeybinding(
      'toggle-keybinding',
      this._settings,
      Meta.KeyBindingFlags.NONE,
      Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
      () => this._toggle()
    );

    this._enabled = true;
  }

  _syncProviders() {
    if (!this._registry || !this._settings)
      return;

    let enabled = [];
    try {
      enabled = this._settings.get_strv('enabled-providers') ?? [];
    } catch (error) {
      logError(error);
      enabled = [];
    }

    const wanted = new Set(Array.isArray(enabled) ? enabled : []);
    for (const provider of this._registry.list()) {
      if (!wanted.has(provider.id))
        this._registry.unregister(provider.id);
    }

    for (const id of wanted) {
      const factory = PROVIDER_FACTORIES[id];
      if (!factory)
        continue;
      if (this._registry.list().some(provider => provider.id === id))
        continue;

      try {
        this._registry.register(factory());
      } catch (error) {
        logError(error);
      }
    }
  }

  _toggle() {
    if (this._modal)
      this._modal.toggle();
  }

  disable() {
    this._enabled = false;

    if (this._providersChangedId && this._settings) {
      try {
        this._settings.disconnect(this._providersChangedId);
      } catch (error) {
        logError(error);
      }
      this._providersChangedId = 0;
    }

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

    this._registry = null;
    this._settings = null;
  }
}