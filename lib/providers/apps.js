import Shell from 'gi://Shell';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import { ttlCache } from '../cache.js';
import { scoreResult } from '../ranking.js';
import { ProviderPriority } from './registry.js';

const PROVIDER_ID = 'apps';
const APPS_CACHE_TTL_MS = 30 * 1000;
const APP_STATE_SIGNAL = 'app-state-changed';
const INSTALLED_SIGNAL = 'installed-changed';

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

function parentDirectory(path) {
  const value = String(path ?? '');
  const index = value.lastIndexOf('/');
  return index > 0 ? value.slice(0, index) : '';
}

function revealPath(path) {
  if (!path)
    return false;
  try {
    const uri = GLib.filename_to_uri(parentDirectory(path), null);
    Gio.AppInfo.launch_default_for_uri(uri, null);
    return true;
  } catch {
    return false;
  }
}

function appWindows(app) {
  try {
    const windows = app.get_windows?.() ?? [];
    return Array.isArray(windows) ? windows.filter(Boolean) : [];
  } catch {
    return [];
  }
}

function windowUserTime(window) {
  try {
    const time = Number(window.get_user_time?.());
    return Number.isFinite(time) ? time : 0;
  } catch {
    return 0;
  }
}

function windowSequence(window) {
  try {
    const sequence = Number(window.get_stable_sequence?.());
    return Number.isFinite(sequence) ? sequence : 0;
  } catch {
    return 0;
  }
}

function newestWindow(windows) {
  return windows
    .slice()
    .sort((a, b) =>
      windowUserTime(b) - windowUserTime(a) ||
      windowSequence(b) - windowSequence(a))[0] ?? null;
}

/**
 * Resolve the live Shell.App for an id. lookup_app() is the authoritative
 * way to check which windows are currently open for an application.
 */
function lookupApp(app, appSystem = null) {
  try {
    const system = appSystem ?? Shell.AppSystem.get_default();
    const appId = app.get_id?.();
    if (appId && typeof system?.lookup_app === 'function')
      return system.lookup_app(appId) ?? app;
  } catch {
    // Fall back to the instance returned by get_installed().
  }
  return app;
}

function currentTime() {
  try {
    return global.get_current_time?.() ?? 0;
  } catch {
    return 0;
  }
}

function activateApp(app) {
  const liveApp = lookupApp(app);
  const windows = appWindows(liveApp);
  if (windows.length > 0) {
    const target = newestWindow(windows);
    if (target)
      liveApp.activate_window(target, currentTime());
    else
      liveApp.activate();
    return;
  }

  liveApp.activate();
}

function toResult(app, query, appSystem) {
  const liveApp = lookupApp(app, appSystem);
  const name = String(liveApp.get_name() ?? '');
  const appInfo = liveApp.get_app_info();
  const description = String(liveApp.get_description() ?? '');
  const executable = appInfo ? String(appInfo.get_executable() ?? '') : '';
  let desktopFile = '';
  try {
    desktopFile = String(appInfo?.get_filename?.() ?? '');
  } catch {
    desktopFile = '';
  }
  const appId = String(liveApp.get_id() ?? name);
  const key = [name, description, executable].filter(Boolean).join(' ');

  if (query === '' || scoreResult(query, { title: name, key }) <= 0)
    return null;

  const icon = liveApp.get_icon?.() ?? null;
  const rows = [
    ['Nazwa', name || '—'],
    ['Opis', description || '—'],
    ['Plik wykonywalny', executable || '—'],
  ];
  if (desktopFile)
    rows.push(['Plik .desktop', desktopFile]);

  return {
    id: appId,
    providerId: PROVIDER_ID,
    title: name || appId,
    subtitle: description || executable,
    kind: 'Aplikacja',
    icon: icon ?? 'application-x-executable-symbolic',
    key,
    usageKey: `apps:${appId}`,
    actions: {
      primary: () => activateApp(liveApp),
      secondary: () => copyText(desktopFile || executable || appId),
      menu: [
        {
          id: 'reveal',
          label: 'Pokaż w plikach',
          callback: () => revealPath(desktopFile),
          disabled: !desktopFile,
        },
        {
          id: 'copy-path',
          label: 'Kopiuj ścieżkę',
          callback: () => copyText(desktopFile || executable || appId),
          disabled: !desktopFile && !executable,
        },
      ],
    },
    preview: {
      rows,
      description,
    },
  };
}

function hasSignal(object, name) {
  try {
    const gtype = object?.constructor?.$gtype;
    return Boolean(gtype) && GObject.signal_lookup(name, gtype) !== 0;
  } catch {
    return false;
  }
}

/**
 * Applications provider backed by Shell.AppSystem. The installed app map is
 * built once and kept for 30 s; Shell's app-state/installed notifications
 * invalidate it immediately where those signals exist (Shell 51 does).
 */
export function createProvider(options = {}) {
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const cache = ttlCache({ ttlMs: APPS_CACHE_TTL_MS, now });
  let appSystem = null;
  let signalIds = [];

  function disconnectSignals() {
    if (!appSystem) {
      signalIds = [];
      return;
    }

    for (const id of signalIds) {
      try {
        appSystem.disconnect(id);
      } catch {
        // The system may already be gone during shell shutdown.
      }
    }
    signalIds = [];
  }

  function watchSignals(system) {
    if (!system || system === appSystem)
      return;

    disconnectSignals();
    appSystem = system;

    for (const name of [APP_STATE_SIGNAL, INSTALLED_SIGNAL]) {
      if (!hasSignal(system, name))
        continue;
      try {
        signalIds.push(system.connect(name, () => cache.invalidate()));
      } catch {
        // A signal that exists but cannot be connected is not fatal.
      }
    }
  }

  function getAppSystem() {
    try {
      const system = Shell.AppSystem.get_default() ?? null;
      watchSignals(system);
      return system;
    } catch {
      return null;
    }
  }

  function buildApps() {
    const system = getAppSystem();
    const apps = new Map();
    if (!system)
      return apps;

    let installed = [];
    try {
      installed = system.get_installed() ?? [];
    } catch {
      installed = [];
    }

    for (const app of installed) {
      if (!app)
        continue;

      let id = '';
      try {
        id = String(app.get_id?.() ?? app.get_name?.() ?? '');
      } catch {
        id = '';
      }
      if (id === '')
        continue;

      if (!apps.has(id))
        apps.set(id, app);
    }

    return apps;
  }

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
      disconnectSignals();
      appSystem = null;
      cache.clear();
    },
    search(query) {
      const needle = String(query ?? '').trim();
      if (needle === '')
        return [];

      const appSystem = getAppSystem();
      if (!appSystem)
        return [];

      const results = [];
      for (const app of getApps().values()) {
        const result = toResult(app, needle, appSystem);
        if (result)
          results.push(result);
      }
      return results;
    },
  };
}

export default createProvider;
