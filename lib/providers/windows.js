import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { scoreResult } from '../ranking.js';
import { planCenter, planTile } from '../window-actions.js';
import { ProviderPriority } from './registry.js';

const PROVIDER_ID = 'windows';
const WORKSPACES_IN_MENU = 4;

function finiteNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

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

function currentTime() {
  try {
    return global.get_current_time?.() ?? 0;
  } catch {
    return 0;
  }
}

function capability(window, method) {
  const callback = window?.[method];
  if (typeof callback !== 'function')
    return false;
  try {
    return Boolean(callback.call(window));
  } catch {
    return false;
  }
}

function workspaceAt(index) {
  try {
    const manager = global.workspace_manager;
    if (typeof manager?.get_workspace_by_index !== 'function')
      return null;
    return manager.get_workspace_by_index(index) ?? null;
  } catch {
    return null;
  }
}

function monitorWorkArea(window) {
  let index = -1;
  try {
    index = Number(window.get_monitor?.() ?? -1);
  } catch {
    index = -1;
  }

  try {
    const monitors = Main.layoutManager?.monitors;
    if (Array.isArray(monitors) && monitors.length > 0) {
      const monitor = monitors[index] ?? monitors[0];
      const area = {
        x: finiteNumber(monitor.x),
        y: finiteNumber(monitor.y),
        width: finiteNumber(monitor.width),
        height: finiteNumber(monitor.height),
      };
      if (area.width > 0 && area.height > 0)
        return area;
    }
  } catch {
    // Fall through to Meta's work-area helpers.
  }

  try {
    let area = null;
    if (index >= 0 && typeof window.get_work_area_for_monitor === 'function')
      area = window.get_work_area_for_monitor(index);
    else if (typeof window.get_work_area_current_monitor === 'function')
      area = window.get_work_area_current_monitor();
    if (!area)
      return null;
    return {
      x: finiteNumber(area.x),
      y: finiteNumber(area.y),
      width: finiteNumber(area.width),
      height: finiteNumber(area.height),
    };
  } catch {
    return null;
  }
}

function moveResizeFrame(window, rect) {
  if (typeof window.move_resize_frame !== 'function')
    return false;
  try {
    window.move_resize_frame(false, rect.x, rect.y, rect.width, rect.height);
    return true;
  } catch {
    return false;
  }
}

function tileWindow(window, side) {
  const mode = Meta.TileMode?.[side.toUpperCase()];
  if (typeof window.tile === 'function' && mode !== undefined && mode !== null) {
    try {
      window.tile(mode);
      return true;
    } catch {
      // Mutter exposes tiling only in some builds; use geometry below.
    }
  }

  const area = monitorWorkArea(window);
  return area ? moveResizeFrame(window, planTile(area, side)) : false;
}

function maximizeWindow(window) {
  const flags = Meta.MaximizeFlags?.BOTH
    ?? ((Meta.MaximizeFlags?.HORIZONTAL ?? 1) | (Meta.MaximizeFlags?.VERTICAL ?? 2));
  if (typeof window.maximize === 'function') {
    try {
      window.maximize(flags);
      return true;
    } catch {
      // Fall back to a large centred rectangle.
    }
  }

  const area = monitorWorkArea(window);
  if (!area)
    return false;
  return moveResizeFrame(
    window,
    planCenter(area, { widthRatio: 0.9, heightRatio: 0.9 })
  );
}

function minimizeWindow(window) {
  if (typeof window.minimize !== 'function')
    return false;
  try {
    window.minimize();
    return true;
  } catch {
    return false;
  }
}

function closeWindow(window) {
  const time = currentTime();
  if (typeof window.close === 'function') {
    try {
      window.close(time);
      return true;
    } catch {
      // Older Mutter exposes delete() instead of close().
    }
  }
  if (typeof window.delete === 'function') {
    try {
      window.delete(time);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

function moveToWorkspace(window, index) {
  const workspace = workspaceAt(index);
  if (!workspace || typeof window.change_workspace !== 'function')
    return false;
  try {
    window.change_workspace(workspace);
    if (typeof window.activate === 'function')
      window.activate(currentTime());
    return true;
  } catch {
    return false;
  }
}

function windowActionMenu(window, title, appName, windowId) {
  const canMove = capability(window, 'allows_move');
  const canResize = capability(window, 'allows_resize');
  const canTile = canMove && canResize &&
    (typeof window.tile === 'function' ||
      typeof window.move_resize_frame === 'function');
  const canMaximize = canMove && canResize &&
    (typeof window.maximize === 'function' ||
      typeof window.move_resize_frame === 'function');
  const copyTitle = () => copyText(title || appName || windowId);

  const items = [
    {
      id: 'activate',
      label: 'Przełącz na okno',
      callback: () => activateWindow(window),
    },
    {
      id: 'copy-title',
      label: 'Kopiuj tytuł',
      callback: copyTitle,
    },
    {
      id: 'tile-left',
      label: 'Przytnij w lewo',
      enabled: canTile,
      callback: () => tileWindow(window, 'left'),
    },
    {
      id: 'tile-right',
      label: 'Przytnij w prawo',
      enabled: canTile,
      callback: () => tileWindow(window, 'right'),
    },
    {
      id: 'maximize',
      label: 'Maksymalizuj',
      enabled: canMaximize && capability(window, 'can_maximize'),
      callback: () => maximizeWindow(window),
    },
  ];

  for (let offset = 0; offset < WORKSPACES_IN_MENU; offset++) {
    const number = offset + 1;
    items.push({
      id: `move-workspace-${number}`,
      label: `Przenieś na przestrzeń ${number}`,
      enabled: canMove &&
        typeof window.change_workspace === 'function' &&
        workspaceAt(offset) !== null,
      callback: () => moveToWorkspace(window, offset),
    });
  }

  items.push(
    {
      id: 'minimize',
      label: 'Minimalizuj',
      enabled: capability(window, 'can_minimize'),
      callback: () => minimizeWindow(window),
    },
    {
      id: 'close',
      label: 'Zamknij',
      enabled: capability(window, 'can_close'),
      callback: () => closeWindow(window),
    }
  );

  return items;
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
      secondary: () => copyText(title || appName || windowId),
      menu: windowActionMenu(
        window,
        title || appName || windowId,
        appName,
        windowId
      ),
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