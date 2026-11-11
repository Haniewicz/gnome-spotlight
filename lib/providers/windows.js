import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { scoreResult } from '../ranking.js';
import { ProviderPriority } from './registry.js';

const PROVIDER_ID = 'windows';

const IGNORED_WINDOW_TYPES = new Set([
  Meta.WindowType.DESKTOP,
  Meta.WindowType.DOCK,
  Meta.WindowType.SPLASHSCREEN,
]);

function allWindows() {
  try {
    if (typeof global.get_window_actors !== 'function')
      return [];
    return global.get_window_actors()
      .map(actor => actor?.meta_window)
      .filter(Boolean);
  } catch {
    return [];
  }
}

function workspaceInfo(window) {
  const workspace = window.get_workspace();
  if (!workspace)
    return { name: '', index: -1 };

  let index = -1;
  try {
    index = Number(workspace.index?.() ?? -1);
  } catch {
    index = -1;
  }

  let name = '';
  try {
    name = String(workspace.get_name?.() ?? '');
  } catch {
    name = '';
  }

  return { name, index };
}

function toResult(window, app, query) {
  const appName = String(app.get_name?.() ?? '');
  const title = String(window.get_title() ?? appName);
  const key = [title, appName].filter(Boolean).join(' ');

  if (query === '' || scoreResult(query, { title, key }) <= 0)
    return null;

  const windowId = String(window.get_id?.() ?? title);
  const workspace = workspaceInfo(window);
  const workspaceLabel = workspace.name ||
    (workspace.index >= 0 ? `Obszar ${workspace.index + 1}` : '—');

  let monitor = -1;
  try {
    monitor = Number(window.get_monitor() ?? -1);
  } catch {
    monitor = -1;
  }

  return {
    id: windowId,
    providerId: PROVIDER_ID,
    title: title || appName || windowId,
    subtitle: [appName, workspaceLabel].filter(Boolean).join(' · '),
    kind: 'Okno',
    icon: app.get_icon?.() ?? 'window-new-symbolic',
    key,
    usageKey: `windows:${windowId}`,
    actions: {
      primary: () => activateWindow(window),
    },
    preview: {
      rows: [
        ['Aplikacja', appName || '—'],
        ['Obszar roboczy', workspaceLabel],
        ['Monitor', monitor >= 0 ? String(monitor + 1) : '—'],
      ],
      description: title,
    },
  };
}

function activateWindow(window) {
  // Shell 51 exports Main.activateWindow(), but keep a feature-checked
  // fallback so the provider also works on older shells.
  if (typeof Main.activateWindow === 'function') {
    Main.activateWindow(window);
    return;
  }

  window.activate(global.get_current_time());
}

/**
 * Open-windows provider. The WindowTracker lookup happens only during
 * search, never at import time.
 */
export function createProvider() {
  return {
    id: PROVIDER_ID,
    title: 'Okna',
    priority: ProviderPriority.NORMAL,
    prefix: null,
    timeoutMs: 300,
    search(query) {
      const needle = String(query ?? '').trim();
      if (needle === '')
        return [];

      const tracker = Shell.WindowTracker.get_default();
      if (!tracker)
        return [];

      const results = [];
      for (const window of allWindows()) {
        let type;
        try {
          type = window.get_window_type?.();
        } catch {
          type = null;
        }
        if (IGNORED_WINDOW_TYPES.has(type))
          continue;

        try {
          if (window.is_skip_taskbar?.())
            continue;
        } catch {
          // Continue with the WindowTracker check below.
        }

        let app = null;
        try {
          app = tracker.get_window_app(window);
        } catch {
          app = null;
        }
        if (!app)
          continue;

        const result = toResult(window, app, needle);
        if (result)
          results.push(result);
      }

      return results;
    },
  };
}

export default createProvider;