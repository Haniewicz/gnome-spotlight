import Shell from 'gi://Shell';

import { scoreResult } from '../ranking.js';
import { ProviderPriority } from './registry.js';

const PROVIDER_ID = 'apps';

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
    },
    preview: {
      rows,
      description,
    },
  };
}

/**
 * Applications provider backed by Shell.AppSystem. All Shell access happens
 * inside search()/actions, so importing this module has no side effects.
 */
export function createProvider() {
  return {
    id: PROVIDER_ID,
    title: 'Aplikacje',
    priority: ProviderPriority.HIGH,
    prefix: null,
    timeoutMs: 300,
    search(query) {
      const needle = String(query ?? '').trim();
      if (needle === '')
        return [];

      const appSystem = Shell.AppSystem.get_default();
      if (!appSystem)
        return [];

      const results = [];
      for (const app of appSystem.get_installed()) {
        const result = toResult(app, needle, appSystem);
        if (result)
          results.push(result);
      }
      return results;
    },
  };
}

export default createProvider;