// Daemon-side GNOME Settings provider. Panels are discovered from desktop
// files through Gio.AppInfo and cached for 60 s.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import { ttlCache } from '../../lib/cache.js';
import { scoreResult } from '../../lib/ranking.js';
import { ProviderPriority } from '../../lib/providers/registry.js';

const PROVIDER_ID = 'settings';
const SETTINGS_CACHE_TTL_MS = 60 * 1000;
const SETTINGS_PANEL_CATEGORY = 'X-GNOME-Settings-Panel';
const MAIN_SETTINGS_ID = 'org.gnome.Settings.desktop';

function applicationDirs() {
  const dirs = ['/usr/share/applications', '/usr/local/share/applications'];
  try {
    dirs.push(`${GLib.get_user_data_dir()}/applications`);
  } catch {
    // User data dir is optional.
  }
  return dirs;
}

function basename(path) {
  const value = String(path ?? '');
  const index = value.lastIndexOf('/');
  return index >= 0 ? value.slice(index + 1) : value;
}

function desktopFileOf(appInfo) {
  try {
    return String(appInfo.get_filename?.() ?? '');
  } catch {
    return '';
  }
}

function panelAppInfo(appInfo) {
  const filename = desktopFileOf(appInfo);
  if (!filename.endsWith('.desktop'))
    return null;
  if (!applicationDirs().some(dir => filename.startsWith(`${dir}/`)))
    return null;

  let id = '';
  try {
    id = String(appInfo.get_id?.() ?? basename(filename));
  } catch {
    id = basename(filename);
  }

  if (id === MAIN_SETTINGS_ID || basename(filename) === MAIN_SETTINGS_ID)
    return { appInfo, id };

  let categories = '';
  try {
    categories = String(appInfo.get_categories?.() ?? '');
  } catch {
    categories = '';
  }

  let categoryKey = '';
  try {
    categoryKey = String(appInfo.get_string?.('X-GNOME-Settings-Panel') ?? '');
  } catch {
    categoryKey = '';
  }

  const isPanel = categories.split(';').includes(SETTINGS_PANEL_CATEGORY) ||
    categoryKey !== '';
  if (!isPanel)
    return null;

  return { appInfo, id };
}

function iconOf(appInfo) {
  try {
    return appInfo.get_icon?.() ?? 'preferences-system-symbolic';
  } catch {
    return 'preferences-system-symbolic';
  }
}

function toResult(panel, query) {
  const { appInfo, id } = panel;
  const name = String(appInfo.get_name?.() ?? id);
  let description = '';
  let executable = '';
  try {
    description = String(appInfo.get_description?.() ?? '');
  } catch {
    description = '';
  }
  try {
    executable = String(appInfo.get_executable?.() ?? '');
  } catch {
    executable = '';
  }
  const desktopFile = desktopFileOf(appInfo);
  const key = [name, id, executable].filter(Boolean).join(' ');

  if (query === '' || scoreResult(query, { title: name, key }) <= 0)
    return null;

  return {
    id,
    providerId: PROVIDER_ID,
    title: name || id,
    subtitle: description || executable,
    kind: 'Ustawienie',
    icon: iconOf(appInfo),
    key,
    path: desktopFile,
    activation: { type: 'settings', appId: id, desktopFile },
    actions: {
      primary: {
        id: 'open-panel',
        label: 'Otwórz panel',
        type: 'settings',
        appId: id,
      },
      secondary: {
        id: 'copy-id',
        label: 'Kopiuj identyfikator',
        type: 'copy',
        text: id,
      },
      menu: [
        {
          id: 'open-panel',
          label: 'Otwórz panel',
          type: 'settings',
          appId: id,
        },
        {
          id: 'copy-id',
          label: 'Kopiuj identyfikator',
          type: 'copy',
          text: id,
        },
      ],
    },
    preview: {
      path: desktopFile,
      rows: [
        ['Panel', id],
        ['Plik wykonywalny', executable || '—'],
        ['Plik .desktop', desktopFile || '—'],
      ],
      description,
    },
  };
}

function buildPanelList() {
  const seen = new Set();
  const panels = [];

  let all = [];
  try {
    all = Gio.AppInfo.get_all() ?? [];
  } catch {
    all = [];
  }

  for (const appInfo of all) {
    const panel = panelAppInfo(appInfo);
    if (!panel || seen.has(panel.id))
      continue;
    seen.add(panel.id);
    panels.push(panel);
  }

  return panels;
}

export function createProvider(options = {}) {
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const cache = ttlCache({ ttlMs: SETTINGS_CACHE_TTL_MS, now });

  function getPanels() {
    return cache.get('panels', buildPanelList);
  }

  return {
    id: PROVIDER_ID,
    title: 'Ustawienia',
    priority: ProviderPriority.NORMAL,
    prefix: null,
    timeoutMs: 300,
    warmUp() {
      getPanels();
    },
    dispose() {
      cache.clear();
    },
    search(query) {
      const needle = String(query ?? '').trim();
      if (needle === '')
        return [];

      const results = [];
      for (const panel of getPanels()) {
        const result = toResult(panel, needle);
        if (result)
          results.push(result);
      }
      return results;
    },
  };
}

export default createProvider;