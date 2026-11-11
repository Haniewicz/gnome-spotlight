import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import GLib from 'gi://GLib';

import { SpotlightModal } from './lib/ui/modal.js';
import { ProviderRegistry } from './lib/providers/registry.js';
import { UsageStore } from './lib/usage.js';
import { createProvider as createAppsProvider } from './lib/providers/apps.js';
import { createProvider as createWindowsProvider } from './lib/providers/windows.js';
import { createProvider as createSettingsProvider } from './lib/providers/settings.js';
import { createProvider as createCommandsProvider } from './lib/providers/commands.js';
import { createProvider as createFilesProvider } from './lib/providers/files.js';
import { createProvider as createCalculatorProvider } from './lib/providers/calculator.js';

const USAGE_SAVE_DELAY_MS = 500;

const PROVIDER_FACTORIES = {
  apps: createAppsProvider,
  windows: createWindowsProvider,
  settings: createSettingsProvider,
  commands: createCommandsProvider,
  files: createFilesProvider,
  calculator: createCalculatorProvider,
};

export default class SpotlightExtension extends Extension {
  constructor(metadata) {
    super(metadata);
    this._settings = null;
    this._modal = null;
    this._registry = null;
    this._usageStore = null;
    this._usageSaveId = 0;
    this._providersChangedId = 0;
    this._enabled = false;
  }

  enable() {
    if (this._enabled)
      return;

    this._settings = this.getSettings();
    this._usageStore = this._loadUsageStore();
    this._registry = new ProviderRegistry(this._usageStore);
    this._syncProviders();

    this._modal = new SpotlightModal(this._settings, {
      registry: this._registry,
      onResultActivated: result => this._recordUsage(result),
      onResultPinned: result => this._pinResult(result),
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
        this._registry.register(factory(this._providerOptions(id)));
      } catch (error) {
        logError(error);
      }
    }
  }

  _providerOptions(id) {
    if (id === 'calculator') {
      return {
        getRates: () => this._readCurrencyRates(),
      };
    }

    if (id === 'files') {
      return {
        getLimit: () => {
          try {
            const value = this._settings?.get_int('max-results');
            return Number.isFinite(value) && value > 0 ? value : undefined;
          } catch {
            return undefined;
          }
        },
      };
    }

    return {};
  }

  _readCurrencyRates() {
    if (!this._settings)
      return null;

    try {
      const raw = this._settings.get_string('currency-rates');
      if (!raw || raw.trim() === '')
        return null;
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed
        : null;
    } catch {
      return null;
    }
  }

  _loadUsageStore() {
    if (!this._settings)
      return UsageStore.parse('{}');

    try {
      return UsageStore.parse(this._settings.get_string('usage-history'));
    } catch {
      return UsageStore.parse('{}');
    }
  }

  _recordUsage(result) {
    if (!this._usageStore || !result)
      return;

    const key = result.usageKey ??
      (result.providerId && result.id !== undefined
        ? `${result.providerId}:${result.id}`
        : null);
    if (!key)
      return;

    this._usageStore.record(String(key), Date.now());
    this._scheduleUsageSave();
  }

  _pinResult(result) {
    if (!this._usageStore || !result)
      return;

    const key = result.usageKey ??
      (result.providerId && result.id !== undefined
        ? `${result.providerId}:${result.id}`
        : null);
    if (!key)
      return;

    this._usageStore.togglePin(String(key));
    this._scheduleUsageSave();
  }

  _scheduleUsageSave() {
    if (!this._settings)
      return;

    // True debounce: each click moves the persistence deadline 500 ms out,
    // so a burst of activations results in exactly one GSettings write.
    this._cancelUsageSave();
    this._usageSaveId = GLib.timeout_add(
      GLib.PRIORITY_DEFAULT,
      USAGE_SAVE_DELAY_MS,
      () => {
        this._usageSaveId = 0;
        this._flushUsage();
        return GLib.SOURCE_REMOVE;
      }
    );
  }

  _cancelUsageSave() {
    if (!this._usageSaveId)
      return;

    try {
      GLib.source_remove(this._usageSaveId);
    } catch {
      // The source may already have fired.
    }
    this._usageSaveId = 0;
  }

  _flushUsage() {
    if (!this._settings || !this._usageStore)
      return;

    try {
      this._settings.set_string('usage-history', this._usageStore.serialize());
    } catch (error) {
      logError(error);
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

    // Flush memory-only usage counters before the settings object goes away.
    this._cancelUsageSave();
    this._flushUsage();

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
    this._usageStore = null;
    this._settings = null;
  }
}
