import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import { ExtensionPreferences } from 'resource:///org/gnome/shell/extensions/prefs.js';

const SHORTCUTS = [
  { label: 'Super + Space', value: '<Super>space' },
  { label: 'Super + Enter', value: '<Super>Return' },
  { label: 'Ctrl + Space', value: '<Control>space' },
  { label: 'Super + S', value: '<Super>s' },
];

const PROVIDERS = [
  { id: 'apps', label: 'Aplikacje' },
  { id: 'windows', label: 'Okna' },
  { id: 'files', label: 'Pliki (locate)' },
  { id: 'settings', label: 'Ustawienia GNOME' },
  { id: 'commands', label: 'Komendy (prefiks >)' },
  { id: 'calculator', label: 'Kalkulator' },
];

const DEFAULT_PROVIDERS = PROVIDERS.map(provider => provider.id);

const MONITORS = [
  { label: 'Pod kursorem', value: 'pointer' },
  { label: 'Aktywne okno', value: 'focused' },
  { label: 'Główny monitor', value: 'primary' },
];

function safeGet(getter, fallback) {
  try {
    const value = getter();
    return value === undefined || value === null ? fallback : value;
  } catch {
    return fallback;
  }
}

function safeSet(setter) {
  try {
    setter();
  } catch {
    // Preferences must stay usable even with a read-only settings backend.
  }
}

function providerIds(settings) {
  const raw = safeGet(() => settings.get_strv('enabled-providers'), DEFAULT_PROVIDERS);
  const list = Array.isArray(raw) ? raw.filter(id => typeof id === 'string') : [];
  return list.length > 0 ? list : [];
}

function shortcutIndex(settings) {
  const values = safeGet(() => settings.get_strv('toggle-keybinding'), []);
  const first = Array.isArray(values) && values.length > 0 ? values[0] : '';
  const index = SHORTCUTS.findIndex(shortcut => shortcut.value === first);
  return index >= 0 ? index : 0;
}

function monitorIndex(settings) {
  const value = safeGet(() => settings.get_string('open-on-monitor'), 'pointer');
  const index = MONITORS.findIndex(monitor => monitor.value === value);
  return index >= 0 ? index : 0;
}

function clampResults(value) {
  const number = Number(value);
  if (!Number.isFinite(number))
    return 8;
  return Math.max(4, Math.min(12, Math.round(number)));
}

/**
 * Adwaita preferences window for Spotlight.
 *
 * The settings object is always obtained from ExtensionPreferences; every
 * read has a deterministic fallback so an empty value never throws.
 */
export default class SpotlightPreferences extends ExtensionPreferences {
  /**
   * @param {Adw.PreferencesWindow} window
   */
  fillPreferencesWindow(window) {
    /** @type {Gio.Settings} */
    const settings = this.getSettings();
    const state = { busy: true };

    window.set_default_size(600, 700);

    const page = new Adw.PreferencesPage({
      title: 'Spotlight',
      icon_name: 'system-search-symbolic',
    });
    window.add(page);

    const shortcutGroup = new Adw.PreferencesGroup({
      title: 'Skrót',
      description: 'Skrót otwiera launcher. Shell rozstrzyga konflikty z innymi skrótami.',
    });
    page.add(shortcutGroup);

    const shortcutRow = new Adw.ComboRow({
      title: 'Otwórz Spotlight',
      model: Gtk.StringList.new(SHORTCUTS.map(shortcut => shortcut.label)),
    });
    shortcutRow.set_selected(shortcutIndex(settings));
    shortcutRow.connect('notify::selected', () => {
      if (state.busy)
        return;
      const shortcut = SHORTCUTS[shortcutRow.get_selected()];
      if (!shortcut)
        return;
      safeSet(() => settings.set_strv('toggle-keybinding', [shortcut.value]));
    });
    shortcutGroup.add(shortcutRow);

    const providersGroup = new Adw.PreferencesGroup({
      title: 'Providery',
      description: 'Wyłącz źródło, aby nie pojawiało się w wynikach.',
    });
    page.add(providersGroup);

    for (const provider of PROVIDERS) {
      const row = new Adw.SwitchRow({
        title: provider.label,
        subtitle: provider.id,
        active: providerIds(settings).includes(provider.id),
      });
      row.connect('notify::active', () => {
        if (state.busy)
          return;
        const enabled = providerIds(settings);
        const index = enabled.indexOf(provider.id);
        if (row.get_active() && index < 0)
          enabled.push(provider.id);
        else if (!row.get_active() && index >= 0)
          enabled.splice(index, 1);
        safeSet(() => settings.set_strv('enabled-providers', enabled));
      });
      providersGroup.add(row);
    }

    const resultsGroup = new Adw.PreferencesGroup({
      title: 'Wyniki i wygląd',
    });
    page.add(resultsGroup);

    const maxRow = new Adw.ActionRow({
      title: 'Maksymalna liczba wyników',
      subtitle: 'Zakres 4–12',
    });
    const adjustment = new Gtk.Adjustment({
      lower: 4,
      upper: 12,
      step_increment: 1,
      page_increment: 1,
      value: clampResults(safeGet(() => settings.get_int('max-results'), 8)),
    });
    const scale = new Gtk.Scale({
      orientation: Gtk.Orientation.HORIZONTAL,
      adjustment,
      digits: 0,
      draw_value: true,
      value_pos: Gtk.PositionType.RIGHT,
      hexpand: true,
      width_request: 200,
      valign: Gtk.Align.CENTER,
    });
    scale.connect('value-changed', () => {
      if (state.busy)
        return;
      safeSet(() => settings.set_int('max-results', clampResults(scale.get_value())));
    });
    maxRow.add_suffix(scale);
    maxRow.set_activatable_widget(scale);
    resultsGroup.add(maxRow);

    const previewRow = new Adw.SwitchRow({
      title: 'Panel podglądu',
      subtitle: 'Ikona, metadane i akcje zaznaczonego wyniku',
      active: safeGet(() => settings.get_boolean('preview-enabled'), true),
    });
    previewRow.connect('notify::active', () => {
      if (state.busy)
        return;
      safeSet(() => settings.set_boolean('preview-enabled', previewRow.get_active()));
    });
    resultsGroup.add(previewRow);

    const monitorRow = new Adw.ComboRow({
      title: 'Otwieraj na monitorze',
      model: Gtk.StringList.new(MONITORS.map(monitor => monitor.label)),
    });
    monitorRow.set_selected(monitorIndex(settings));
    monitorRow.connect('notify::selected', () => {
      if (state.busy)
        return;
      const monitor = MONITORS[monitorRow.get_selected()];
      if (!monitor)
        return;
      safeSet(() => settings.set_string('open-on-monitor', monitor.value));
    });
    resultsGroup.add(monitorRow);

    state.busy = false;
  }
}