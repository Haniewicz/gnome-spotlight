// Declarative action executor for results coming from gnome-spotlightd.
//
// The daemon serializes actions to JSON; this module turns those descriptors
// back into side effects inside the Shell. All GI modules and process helpers
// are injected through `deps`, so the runner can be tested without a live
// GNOME Shell session:
//
//   {St, Shell, Gio, GLib, Main, spawn, daemonCall}
//
// The argv builders are PURE on purpose: command/reveal spawning is easy to
// regress, and asserting on argv is cheaper and safer than starting terminals.

const SYSTEMD_BUS = 'org.freedesktop.systemd1';
const SYSTEMD_PATH = '/org/freedesktop/systemd1';
const SYSTEMD_INTERFACE = 'org.freedesktop.systemd1.Manager';

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safeLogError(error) {
  try {
    if (typeof globalThis.logError === 'function') {
      globalThis.logError(error);
      return;
    }
  } catch {
    // Fall through to the non-Shell logger.
  }
  try {
    if (typeof logError === 'function') {
      logError(error);
      return;
    }
  } catch {
    // Shell logging is optional in tests.
  }
  try {
    printerr(`gnome-spotlight: ${error?.message ?? error}`);
  } catch {
    // Logging must never break activation.
  }
}

function normalizeAction(value) {
  if (typeof value === 'function')
    return value;
  if (isPlainObject(value))
    return value;
  return null;
}

/**
 * Normalize the `actions` field of a result.
 *
 * Accepts the daemon JSON string, an already parsed object, a result object
 * carrying `actions`, or null. Invalid JSON is reported through logError and
 * yields an empty object; this helper never throws.
 *
 * @param {*} result
 * @returns {{primary: *, secondary: *, menu: object[]}|{}}
 */
export function parseActions(result) {
  let value = result;

  if (isPlainObject(result) &&
      Object.prototype.hasOwnProperty.call(result, 'actions'))
    value = result.actions;

  if (value === null || value === undefined)
    return {};

  if (typeof value === 'string') {
    const text = value.trim();
    if (text === '')
      return {};
    try {
      value = JSON.parse(text);
    } catch (error) {
      safeLogError(error);
      return {};
    }
  }

  // Also accept a JSON string containing a complete result object.
  if (isPlainObject(value) &&
      Object.prototype.hasOwnProperty.call(value, 'actions'))
    value = value.actions;

  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch (error) {
      safeLogError(error);
      return {};
    }
  }

  if (!isPlainObject(value))
    return {};

  const primary = normalizeAction(value.primary);
  const secondary = normalizeAction(value.secondary);
  const menu = Array.isArray(value.menu)
    ? value.menu.map(normalizeAction).filter(Boolean)
    : [];

  return { primary, secondary, menu };
}

/**
 * Pure argv builder for terminal commands. The command is passed to bash as
 * one argument, so quoting inside the command string keeps working.
 *
 * @param {string} command
 * @param {string} [terminal]
 * @returns {string[]}
 */
export function argvForCommand(command, terminal = 'gnome-terminal') {
  const text = String(command ?? '');
  const selected = String(terminal ?? 'gnome-terminal');
  if (selected === 'kgx')
    return ['kgx', '-e', 'bash', '-lc', text];
  return [selected, '--', 'bash', '-lc', text];
}

function parentDirectory(path) {
  const value = String(path ?? '');
  const index = value.lastIndexOf('/');
  if (index > 0)
    return value.slice(0, index);
  if (index === 0)
    return '/';
  return '.';
}

/**
 * Pure argv builder for revealing a file. Nautilus is preferred when the
 * caller knows it is available; otherwise the file manager directory is
 * opened through `gio open`.
 *
 * @param {string} path
 * @param {boolean|{nautilus?: boolean, hasNautilus?: boolean}} [available]
 * @returns {string[]}
 */
export function argvForReveal(path, available = false) {
  const value = String(path ?? '');
  const hasNautilus = isPlainObject(available)
    ? Boolean(available.nautilus ?? available.hasNautilus)
    : Boolean(available);
  if (hasNautilus)
    return ['nautilus', '--select', value];
  return ['gio', 'open', parentDirectory(value)];
}

function hasProgram(name, deps) {
  if (typeof deps?.hasProgram === 'function') {
    try {
      return Boolean(deps.hasProgram(name));
    } catch {
      return false;
    }
  }
  try {
    return Boolean(deps?.GLib?.find_program_in_path?.(name));
  } catch {
    return false;
  }
}

function chooseTerminal(deps) {
  if (typeof deps?.terminal === 'string' && deps.terminal !== '')
    return deps.terminal;
  const hasGnomeTerminal = hasProgram('gnome-terminal', deps);
  const hasKgx = hasProgram('kgx', deps);
  if (!hasGnomeTerminal && hasKgx)
    return 'kgx';
  return 'gnome-terminal';
}

function spawnArgv(deps, argv) {
  if (typeof deps?.spawn !== 'function')
    return false;
  try {
    deps.spawn(argv.map(value => String(value)));
    return true;
  } catch (error) {
    safeLogError(error);
    return false;
  }
}

function desktopAppInfo(deps, filename) {
  if (!filename)
    return null;
  try {
    const factory = deps?.Gio?.DesktopAppInfo ??
      deps?.GioUnix?.DesktopAppInfo ?? null;
    if (!factory || typeof factory.new_from_filename !== 'function')
      return null;
    return factory.new_from_filename(String(filename));
  } catch {
    return null;
  }
}

function shellApp(deps, appId) {
  if (!appId)
    return null;
  try {
    const appSystem = deps?.Shell?.AppSystem?.get_default?.();
    if (!appSystem || typeof appSystem.lookup_app !== 'function')
      return null;
    return appSystem.lookup_app(String(appId)) ?? null;
  } catch {
    return null;
  }
}

function activateApp(action, result, deps) {
  const appId = action.appId ?? action.desktopId ?? '';
  const desktopFile = action.desktopFile ??
    action.path ??
    result?.path ??
    result?.activation?.desktopFile ??
    '';

  const app = shellApp(deps, appId);
  if (app && typeof app.activate === 'function') {
    try {
      app.activate();
      return true;
    } catch (error) {
      safeLogError(error);
    }
  }

  const info = desktopAppInfo(deps, desktopFile);
  if (!info || typeof info.launch !== 'function') {
    safeLogError(new Error(`nie można uruchomić aplikacji: ${appId || desktopFile || '?'}`));
    return false;
  }

  try {
    info.launch([], null);
    return true;
  } catch (error) {
    safeLogError(error);
    return false;
  }
}

function openFile(action, result, deps) {
  const path = action.path ?? action.filePath ?? result?.path ?? '';
  if (!path) {
    safeLogError(new Error('akcja file bez ścieżki'));
    return false;
  }

  try {
    if (typeof deps?.Gio?.AppInfo?.launch_default_for_uri !== 'function')
      throw new Error('Gio.AppInfo niedostępne');
    deps.Gio.AppInfo.launch_default_for_uri(`file://${String(path)}`, null);
    return true;
  } catch (error) {
    safeLogError(error);
    return false;
  }
}

function revealFile(action, result, deps) {
  const path = action.path ?? action.filePath ?? result?.path ?? '';
  if (!path || typeof deps?.spawn !== 'function')
    return false;
  return spawnArgv(deps, argvForReveal(path, hasProgram('nautilus', deps)));
}

function openSettings(action, result, deps) {
  const filename = action.desktopFile ??
    action.path ??
    result?.path ??
    result?.activation?.desktopFile ??
    '';
  let info = desktopAppInfo(deps, filename);

  if (!info) {
    const appId = action.appId ?? '';
    if (appId) {
      try {
        const factory = deps?.Gio?.DesktopAppInfo ??
          deps?.GioUnix?.DesktopAppInfo ?? null;
        if (factory && typeof factory.new === 'function')
          info = factory.new(String(appId));
      } catch {
        info = null;
      }
    }
  }

  if (!info && action.appId) {
    const app = shellApp(deps, action.appId);
    if (app && typeof app.activate === 'function') {
      try {
        app.activate();
        return true;
      } catch (error) {
        safeLogError(error);
      }
    }
  }

  if (!info || typeof info.launch !== 'function') {
    safeLogError(new Error(`nie można otworzyć panelu: ${filename || action.appId || '?'}`));
    return false;
  }

  try {
    info.launch([], null);
    return true;
  } catch (error) {
    safeLogError(error);
    return false;
  }
}

function copyText(action, deps) {
  const text = action.text ?? action.value ?? '';
  try {
    const clipboard = deps?.St?.Clipboard?.get_default?.();
    const clipboardType = deps?.St?.ClipboardType?.CLIPBOARD;
    if (!clipboard || typeof clipboard.set_text !== 'function' ||
        clipboardType === undefined)
      throw new Error('St.Clipboard niedostępne');
    clipboard.set_text(clipboardType, String(text));
    return true;
  } catch (error) {
    safeLogError(error);
    return false;
  }
}

function runCommand(action, deps) {
  let argv = null;
  if (action.command !== undefined && action.command !== null) {
    argv = argvForCommand(action.command, chooseTerminal(deps));
  } else if (Array.isArray(action.argv)) {
    argv = action.argv;
  }

  if (!argv || argv.length === 0) {
    safeLogError(new Error('akcja command bez polecenia'));
    return false;
  }
  return spawnArgv(deps, argv);
}

function systemdMethod(action) {
  if (typeof action.method === 'string' && action.method.trim() !== '')
    return action.method.trim();
  const verb = String(action.verb ?? action.command ?? '').trim();
  if (verb === '')
    return '';
  if (/Unit$/.test(verb))
    return verb;
  return `${verb.charAt(0).toUpperCase()}${verb.slice(1)}Unit`;
}

function runSystemd(action, result, deps) {
  const unit = action.unit ?? action.name ?? action.path ?? result?.path ?? '';
  const method = systemdMethod(action);
  if (!unit || !method) {
    safeLogError(new Error('akcja systemd bez jednostki lub czasownika'));
    return false;
  }

  const connection = deps?.Gio?.DBus?.session;
  const Variant = deps?.GLib?.Variant;
  const VariantType = deps?.GLib?.VariantType;
  if (!connection || typeof connection.call !== 'function' ||
      typeof Variant !== 'function')
    return false;

  const busName = action.busName ?? SYSTEMD_BUS;
  const objectPath = action.objectPath ?? SYSTEMD_PATH;
  const interfaceName = action.interface ?? SYSTEMD_INTERFACE;

  try {
    const parameters = new Variant('(ss)', [String(unit), 'replace']);
    connection.call(
      busName,
      objectPath,
      interfaceName,
      method,
      parameters,
      typeof VariantType === 'function' ? new VariantType('(o)') : null,
      deps?.Gio?.DBusCallFlags?.NONE ?? 0,
      -1,
      null,
      (_connection, reply) => {
        try {
          if (typeof connection.call_finish === 'function')
            connection.call_finish(reply);
        } catch (error) {
          safeLogError(error);
        }
      }
    );
    return true;
  } catch (error) {
    safeLogError(error);
    return false;
  }
}

function dockerArgv(action) {
  if (Array.isArray(action.argv) && action.argv.length > 0)
    return action.argv.map(value => String(value));

  const containerId = action.containerId ??
    action.container ??
    action.dockerId ??
    action.resourceId ??
    action.target ??
    '';
  if (containerId)
    return ['docker', 'stop', String(containerId)];

  const command = String(action.command ?? '').trim();
  if (command !== '') {
    const tokens = command.split(/\s+/);
    if (tokens.length === 1)
      return ['docker', 'stop', tokens[0]];
    return tokens;
  }

  const id = String(action.id ?? '');
  if (id !== '' && id !== 'docker-stop')
    return ['docker', 'stop', id];
  return null;
}

function stopDocker(action, deps) {
  const argv = dockerArgv(action);
  if (!argv) {
    safeLogError(new Error('akcja docker-stop bez identyfikatora'));
    return false;
  }
  return spawnArgv(deps, argv);
}

function activateRemote(action, result, deps) {
  if (typeof deps?.daemonCall !== 'function') {
    safeLogError(new Error('brak daemonCall dla akcji remote'));
    return false;
  }

  const id = action.remoteId
    ? (result?.id ??
      (action.busName ? `${action.busName}:${action.remoteId}` : action.remoteId))
    : (action.id ??
      action.nativeId ??
      action.target ??
      result?.id ??
      '');
  if (id === '') {
    safeLogError(new Error('akcja remote bez identyfikatora'));
    return false;
  }

  try {
    const pending = deps.daemonCall('Activate', String(id));
    if (pending && typeof pending.catch === 'function')
      pending.catch(error => safeLogError(error));
    return pending !== false;
  } catch (error) {
    safeLogError(error);
    return false;
  }
}

/**
 * Execute one declarative action.
 *
 * @param {object|Function|null} action
 * @param {object|null} result
 * @param {{St?: object, Shell?: object, Gio?: object, GLib?: object, Main?: object, spawn?: Function, daemonCall?: Function, hasProgram?: Function, terminal?: string}} deps
 * @returns {boolean} true when the side effect was started
 */
export function runAction(action, result, deps = {}) {
  try {
    const descriptor = isPlainObject(action)
      ? action
      : isPlainObject(result?.activation)
        ? result.activation
        : action;

    if (!isPlainObject(descriptor))
      return false;

    const type = String(descriptor.type ?? '').trim().toLowerCase();
    switch (type) {
    case 'app':
      return activateApp(descriptor, result, deps);
    case 'file':
      return openFile(descriptor, result, deps);
    case 'reveal':
      return revealFile(descriptor, result, deps);
    case 'settings':
      return openSettings(descriptor, result, deps);
    case 'copy':
      return copyText(descriptor, deps);
    case 'command':
      return runCommand(descriptor, deps);
    case 'systemd':
      return runSystemd(descriptor, result, deps);
    case 'docker-stop':
      return stopDocker(descriptor, deps);
    case 'remote':
      return activateRemote(descriptor, result, deps);
    default:
      safeLogError(new Error(`nieznany typ akcji: ${type || '(brak)'}`));
      return false;
    }
  } catch (error) {
    safeLogError(error);
    return false;
  }
}

export default runAction;