import Gio from 'gi://Gio';

import { scoreResult } from '../ranking.js';
import { ProviderPriority } from './registry.js';

const PROVIDER_ID = 'settings';
const APPLICATIONS_DIR = '/usr/share/applications';
const SETTINGS_PANEL_CATEGORY = 'X-GNOME-Settings-Panel';
const MAIN_SETTINGS_ID = 'org.gnome.Settings.desktop';

async function copyText(text) {
  try {
    const { default: St } = await import('gi://St');
    St.Clipboard.get_default().set_text(
      St.ClipboardType.CLIPBOARD,
      String(text ?? '')
    );
  } catch {
    // Clipboard access is best effort.
  }
}

function basename(path) {
  const value = String(path ?? '');
  const index = value.lastIndexOf('/');
  return index >= 0 ? value.slice(index + 1) : value;
}

function settingsAppInfo(app) {
  let filename = '';
  try {
    filename = String(app.get_filename() ?? '');
  } catch {
    return null;
  }

  if (!filename.startsWith(`${APPLICATIONS_DIR}/`) || !filename.endsWith('.desktop'))
    return null;

  let id = '';
  try {
    id = String(app.get_id() ?? basename(filename));
  } catch {
    id = basename(filename);
  }

  if (id === MAIN_SETTINGS_ID || basename(filename) === MAIN_SETTINGS_ID)
    return { app, id };

  let categories = '';
  try {
    categories = String(app.get_categories() ?? '');
  } catch {
    categories = '';
  }

  if (!categories.split(';').includes(SETTINGS_PANEL_CATEGORY))
    return null;

  return { app, id };
}

function toResult(app, id, query) {
  const name = String(app.get_name() ?? id);
  let description = '';
  let executable = '';
  try {
    description = String(app.get_description() ?? '');
  } catch {
    description = '';
  }
  try {
    executable = String(app.get_executable() ?? '');
  } catch {
    executable = '';
  }

  const key = [name, id, executable].filter(Boolean).join(' ');
  if (query === '' || scoreResult(query, { title: name, key }) <= 0)
    return null;

  return {
    id,
    providerId: PROVIDER_ID,
    title: name || id,
    subtitle: description || executable,
    kind: 'Ustawienie',
    icon: app.get_icon?.() ?? 'preferences-system-symbolic',
    key,
    usageKey: `settings:${id}`,
    actions: {
      primary: () => app.launch([], null),
      secondary: () => copyText(id),
      menu: [
        {
          id: 'open-panel',
          label: 'Otwórz panel',
          callback: () => app.launch([], null),
        },
        {
          id: 'copy-id',
          label: 'Kopiuj identyfikator',
          callback: () => copyText(id),
        },
      ],
    },
    preview: {
      rows: [
        ['Panel', id],
        ['Plik wykonywalny', executable || '—'],
      ],
      description,
    },
  };
}

/**
 * GNOME Settings provider. Panels are discovered from Gio.AppInfo at search
 * time, so importing this module does not enumerate desktop files.
 */
export function createProvider() {
  return {
    id: PROVIDER_ID,
    title: 'Ustawienia',
    priority: ProviderPriority.NORMAL,
    prefix: null,
    timeoutMs: 300,
    search(query) {
      const needle = String(query ?? '').trim();
      if (needle === '')
        return [];

      const seen = new Set();
      const results = [];

      for (const appInfo of Gio.AppInfo.get_all()) {
        const panel = settingsAppInfo(appInfo);
        if (!panel || seen.has(panel.id))
          continue;
        seen.add(panel.id);

        const result = toResult(panel.app, panel.id, needle);
        if (result)
          results.push(result);
      }

      return results;
    },
  };
}

export default createProvider;