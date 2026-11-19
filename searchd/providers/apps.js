// Daemon-side applications provider. Uses Gio.AppInfo only, never Shell's
// AppSystem, so the module can run in a plain GJS daemon.
import Gio from 'gi://Gio';
import GioUnix from 'gi://GioUnix';
import GLib from 'gi://GLib';

import { ttlCache } from '../../lib/cache.js';
import {
  desktopList,
  shouldShowOnDesktops,
} from '../../lib/desktop-visibility.js';
import { scoreResult } from '../../lib/ranking.js';
import { ProviderPriority } from '../../lib/providers/registry.js';

const PROVIDER_ID = 'apps';
const APPS_CACHE_TTL_MS = 30 * 1000;

function stringKey(appInfo, key) {
  try {
    return String(appInfo.get_string?.(key) ?? '');
  } catch {
    return '';
  }
}

function daemonDesktops() {
  let raw = '';
  try {
    raw = String(
      GLib.getenv('XDG_CURRENT_DESKTOP') ??
      GLib.getenv('XDG_SESSION_DESKTOP') ??
      ''
    );
  } catch {
    raw = '';
  }
  return desktopList(raw);
}

function shouldShow(appInfo) {
  let shown = true;
  try {
    shown = appInfo.should_show ? appInfo.should_show() : true;
  } catch {
    shown = true;
  }
  if (shown)
    return true;

  // Gio.AppInfo.should_show() reads XDG_CURRENT_DESKTOP. The daemon may be
  // started from systemd's default.target before gnome-session exports that
  // variable, in which case should_show() reports false for every GNOME-only
  // app (Extension Manager, GNOME Extensions, ...) for the whole daemon
  // lifetime. Re-evaluate OnlyShowIn/NotShowIn against GNOME instead of
  // hiding those apps outright; Hidden/NoDisplay are checked separately
  // below.
  return shouldShowOnDesktops({
    onlyShowIn: stringKey(appInfo, 'OnlyShowIn'),
    notShowIn: stringKey(appInfo, 'NotShowIn'),
    desktops: daemonDesktops(),
  });
}

function isHidden(appInfo) {
  if (!shouldShow(appInfo))
    return true;

  for (const key of ['Hidden', 'NoDisplay']) {
    try {
      if (appInfo.get_boolean?.(key) === true)
        return true;
    } catch {
      // Not every Gio.AppInfo is a Gio.DesktopAppInfo.
    }
  }

  return false;
}

function appIdOf(appInfo) {
  try {
    return String(appInfo.get_id?.() ?? '');
  } catch {
    return '';
  }
}

function desktopFileOf(appInfo) {
  try {
    return String(appInfo.get_filename?.() ?? '');
  } catch {
    return '';
  }
}

function iconOf(appInfo) {
  try {
    return appInfo.get_icon?.() ?? 'application-x-executable-symbolic';
  } catch {
    return 'application-x-executable-symbolic';
  }
}

function toRecord(appInfo) {
  if (!appInfo || isHidden(appInfo))
    return null;

  const id = appIdOf(appInfo);
  if (id === '')
    return null;

  // Only desktop entries are launchable applications. `get_all()` normally
  // returns Gio.DesktopAppInfo (GioUnix.DesktopAppInfo in gjs 1.90); the
  // filename check keeps plain Gio.AppInfo implementations from leaking in.
  const desktopFile = desktopFileOf(appInfo);
  const isDesktopInfo = appInfo instanceof GioUnix.DesktopAppInfo;
  if (!desktopFile.endsWith('.desktop') && !isDesktopInfo)
    return null;

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

  return {
    id,
    name,
    description,
    executable,
    desktopFile,
    icon: iconOf(appInfo),
    key: [name, description, executable, id].filter(Boolean).join(' '),
  };
}

function toResult(record, query) {
  if (query === '' || scoreResult(query, { title: record.name, key: record.key }) <= 0)
    return null;

  return {
    id: record.id,
    providerId: PROVIDER_ID,
    title: record.name || record.id,
    subtitle: record.description || record.executable,
    kind: 'Aplikacja',
    icon: record.icon,
    key: record.key,
    path: record.desktopFile,
    activation: { type: 'app', appId: record.id, desktopFile: record.desktopFile },
    actions: {
      primary: {
        id: 'launch',
        label: 'Uruchom',
        type: 'app',
        appId: record.id,
        desktopFile: record.desktopFile,
      },
      secondary: {
        id: 'copy-path',
        label: 'Kopiuj ścieżkę',
        type: 'copy',
        text: record.desktopFile || record.executable || record.id,
      },
      menu: [
        {
          id: 'launch',
          label: 'Uruchom',
          type: 'app',
          appId: record.id,
        },
        {
          id: 'copy-path',
          label: 'Kopiuj ścieżkę',
          type: 'copy',
          text: record.desktopFile || record.executable || record.id,
        },
      ],
    },
    preview: {
      path: record.desktopFile,
      rows: [
        ['Nazwa', record.name || '—'],
        ['Opis', record.description || '—'],
        ['Plik wykonywalny', record.executable || '—'],
        ['Plik .desktop', record.desktopFile || '—'],
      ],
      description: record.description,
    },
  };
}

function buildApps() {
  const apps = new Map();

  let all = [];
  try {
    all = Gio.AppInfo.get_all() ?? [];
  } catch {
    all = [];
  }

  for (const appInfo of all) {
    const record = toRecord(appInfo);
    if (!record || apps.has(record.id))
      continue;
    apps.set(record.id, record);
  }

  return apps;
}

export function createProvider(options = {}) {
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const cache = ttlCache({ ttlMs: APPS_CACHE_TTL_MS, now });

  function getApps() {
    return cache.get('apps', buildApps);
  }

  return {
    id: PROVIDER_ID,
    title: 'Aplikacje',
    priority: ProviderPriority.HIGH,
    prefix: null,
    timeoutMs: 300,
    warmUp() {
      getApps();
    },
    dispose() {
      cache.clear();
    },
    search(query) {
      const needle = String(query ?? '').trim();
      if (needle === '')
        return [];

      const results = [];
      for (const record of getApps().values()) {
        const result = toResult(record, needle);
        if (result)
          results.push(result);
      }
      return results;
    },
  };
}

export default createProvider;