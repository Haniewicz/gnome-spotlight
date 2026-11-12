#!/usr/bin/env -S gjs -m
// gnome-spotlightd: heavy search sources in a separate GJS process.
//
// The daemon deliberately imports neither St, Shell, Clutter nor any GNOME
// Shell resource module, so it can run outside a Shell session (DESIGN §13).
import Gio from 'gi://Gio';
import GioUnix from 'gi://GioUnix';
import GLib from 'gi://GLib';
import GLibUnix from 'gi://GLibUnix';
import system from 'system';

import { DaemonRegistry, REMOTE_PROVIDERS_KEY } from './registry.js';
import { SearchProvider2, SEARCH_PROVIDER_XML } from './searchProvider2.js';
import {
  iconToString,
  resultDescription,
  resultPath,
  serializeActions,
} from './serialize.js';
import { createProvider as createAppsProvider } from './providers/apps.js';
import { createProvider as createSettingsProvider } from './providers/settings.js';
import { createProvider as createFilesProvider } from './providers/files.js';
import { createProvider as createCommandsProvider } from './providers/commands.js';
import { createProvider as createCalculatorProvider } from './providers/calculator.js';
import { createProvider as createRemoteProvider } from './providers/remote.js';

const VERSION = '1.0.0';
const BUS_NAME = 'org.gnome.Spotlight';
const OBJECT_PATH = '/org/gnome/Spotlight/Search';
const SEARCH_INTERFACE = 'org.gnome.Spotlight.Search';
const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 100;
const SCHEMA_ID = 'org.gnome.shell.extensions.spotlight';
const EXTENSION_UUID = 'spotlight@haniewicz.dev';
const REMOTE_CACHE_TTL_MS = 5 * 1000;

const SEARCH_XML = `
<node>
  <interface name="org.gnome.Spotlight.Search">
    <method name="Search">
      <arg type="s" name="query" direction="in"/>
      <arg type="s" name="mode" direction="in"/>
      <arg type="i" name="limit" direction="in"/>
      <arg type="aa{sv}" name="results" direction="out"/>
      <arg type="s" name="stats" direction="out"/>
    </method>
    <method name="Quit"/>
    <property name="Version" type="s" access="read"/>
  </interface>
</node>`;

function stringVariant(value) {
  return new GLib.Variant('s', String(value ?? ''));
}

function doubleVariant(value) {
  const number = Number(value);
  return new GLib.Variant('d', Number.isFinite(number) ? number : 0);
}

function resultToVardict(result) {
  return {
    id: stringVariant(result.id),
    name: stringVariant(result.title ?? result.name ?? ''),
    description: stringVariant(resultDescription(result)),
    icon: stringVariant(iconToString(result.icon)),
    kind: stringVariant(result.kind ?? ''),
    provider: stringVariant(result.providerId ?? ''),
    score: doubleVariant(result.score),
    path: stringVariant(resultPath(result)),
    actions: stringVariant(serializeActions(result.actions)),
  };
}

function normalizeLimit(limit) {
  if (limit === undefined || limit === null)
    return DEFAULT_LIMIT;
  const value = Number(limit);
  if (!Number.isFinite(value))
    return DEFAULT_LIMIT;
  return Math.max(0, Math.min(MAX_LIMIT, Math.floor(value)));
}

function normalizeMode(mode) {
  return String(mode ?? '').trim().toLowerCase();
}

function schemaForSettings() {
  try {
    const source = Gio.SettingsSchemaSource.get_default();
    const schema = source?.lookup(SCHEMA_ID, true);
    if (schema)
      return schema;
  } catch {
    // Fall through to the extension-local schema.
  }

  // Extension schemas are installed inside the extension directory, not in
  // the default GSettings source. Look there so the preferences switch also
  // controls the daemon when the extension is deployed normally.
  try {
    const extensionSchemas = GLib.build_filenamev([
      GLib.get_user_data_dir(),
      'gnome-shell',
      'extensions',
      EXTENSION_UUID,
      'schemas',
    ]);
    const source = Gio.SettingsSchemaSource.new_from_directory(
      extensionSchemas,
      Gio.SettingsSchemaSource.get_default(),
      false
    );
    return source?.lookup(SCHEMA_ID, true) ?? null;
  } catch {
    return null;
  }
}

/**
 * Read the daemon-side switch. Missing schema (for example a daemon started
 * straight from the repository) keeps the native providers enabled.
 *
 * @returns {boolean}
 */
function remoteProvidersEnabled() {
  const schema = schemaForSettings();
  if (!schema)
    return true;
  try {
    const settings = Gio.Settings.new_full(schema, null, null);
    return settings.get_boolean(REMOTE_PROVIDERS_KEY) !== false;
  } catch {
    return true;
  }
}

function launchApp(appId, desktopFile) {
  let info = null;
  try {
    if (appId)
      info = GioUnix.DesktopAppInfo.new(String(appId));
  } catch {
    info = null;
  }
  if (!info && desktopFile) {
    try {
      info = GioUnix.DesktopAppInfo.new_from_filename(String(desktopFile));
    } catch {
      info = null;
    }
  }
  if (!info)
    return false;

  try {
    info.launch([], null);
    return true;
  } catch {
    return false;
  }
}

function openPath(path) {
  try {
    const uri = GLib.filename_to_uri(String(path), null);
    Gio.AppInfo.launch_default_for_uri(uri, null);
    return true;
  } catch {
    return false;
  }
}

let activeRemoteProvider = null;

/**
 * Execute the side effect described by a result. Commands are intentionally
 * not spawned here: the extension client owns terminal launching.
 */
function activateResult(result) {
  const activation = result?.activation ?? {};
  switch (activation.type) {
  case 'app':
  case 'settings':
    return launchApp(activation.appId, activation.desktopFile);
  case 'file':
    return openPath(activation.path);
  case 'command':
    // The client extension runs commands in a terminal.
    return true;
  case 'copy':
    // Clipboard belongs to the Shell client.
    return true;
  case 'remote': {
    if (!activeRemoteProvider)
      return false;
    const remoteId = activation.remoteId
      ? `${activation.busName}:${activation.remoteId}`
      : String(result?.id ?? '');
    activeRemoteProvider.activate(
      remoteId,
      Array.isArray(activation.terms) ? activation.terms : undefined,
      0
    ).catch(error => {
      printerr(`gnome-spotlightd: remote activation failed: ${error.message}`);
    });
    return true;
  }
  default:
    return false;
  }
}

function createRegistry() {
  const registry = new DaemonRegistry({ activate: activateResult });
  for (const provider of [
    createAppsProvider(),
    createCommandsProvider(),
    createCalculatorProvider(),
    createSettingsProvider(),
    createFilesProvider(),
  ])
    registry.register(provider);

  activeRemoteProvider = null;
  if (remoteProvidersEnabled()) {
    try {
      activeRemoteProvider = createRemoteProvider({
        cacheTtlMs: REMOTE_CACHE_TTL_MS,
      });
      registry.register(activeRemoteProvider);
    } catch (error) {
      printerr(`gnome-spotlightd: remote providers disabled: ${error.message}`);
      activeRemoteProvider = null;
    }
  }
  return registry;
}

function printVersion() {
  print(`gnome-spotlightd ${VERSION}`);
}

function main(argv) {
  const args = Array.isArray(argv) ? argv : [];
  if (args.includes('--check') || args.includes('--version') || args.includes('-v')) {
    printVersion();
    return 0;
  }
  if (args.includes('--help') || args.includes('-h')) {
    print('Usage: gjs -m searchd/main.js [--check|--version]');
    return 0;
  }

  const registry = createRegistry();

  // Warm the expensive enumerations before owning the bus name. D-Bus
  // activation then waits for a daemon whose caches are already hot, and the
  // first Search stays within the 30 ms budget.
  for (const provider of registry.list()) {
    if (typeof provider.warmUp !== 'function')
      continue;
    try {
      provider.warmUp();
    } catch {
      // A warm-up failure must not prevent the daemon from starting.
    }
  }

  let connection;
  try {
    connection = Gio.bus_get_sync(Gio.BusType.SESSION, null);
  } catch (error) {
    printerr(`gnome-spotlightd: cannot connect to session bus: ${error.message}`);
    return 1;
  }

  const loop = new GLib.MainLoop(null, false);
  let exportedSearch = null;
  let exportedProvider = null;
  let ownerId = 0;
  let shuttingDown = false;
  let nameAcquired = false;

  const shutdown = code => {
    if (shuttingDown)
      return;
    shuttingDown = true;

    try {
      exportedSearch?.unexport();
    } catch {
      // Already unexported.
    }
    try {
      exportedProvider?.unexport();
    } catch {
      // Already unexported.
    }
    exportedSearch = null;
    exportedProvider = null;

    if (ownerId) {
      try {
        Gio.bus_unown_name(ownerId);
      } catch {
        // The connection may already be gone.
      }
      ownerId = 0;
    }

    try {
      connection?.close_sync(null);
    } catch {
      // Closing an already closed bus is harmless.
    }

    loop.quit();
    if (code !== 0)
      system.exit(code);
  };

  const searchImpl = {
    Version: VERSION,
    async Search(query, mode, limit) {
      const needle = String(query ?? '');
      const selectedMode = normalizeMode(mode);
      const maxResults = normalizeLimit(limit);

      if (selectedMode !== '' &&
          !['all', 'apps', 'settings', 'files', 'commands', 'calculator']
            .includes(selectedMode)) {
        throw new Error(`unknown search mode: ${selectedMode}`);
      }

      if (maxResults === 0) {
        return [[], JSON.stringify({ total: 0, truncated: false, ms: {} })];
      }

      const response = await registry.search(needle, {
        mode: selectedMode,
        limit: maxResults,
        perProviderLimit: maxResults,
      });

      const results = response.results.map(resultToVardict);
      const stats = {
        total: response.stats.total,
        truncated: response.stats.truncated,
        ms: response.stats.ms,
        errors: Array.isArray(response.stats.errors)
          ? response.stats.errors
          : response.errors ?? [],
      };
      return [results, JSON.stringify(stats)];
    },
    Quit() {
      GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
        shutdown(0);
        return GLib.SOURCE_REMOVE;
      });
    },
  };

  const providerImpl = new SearchProvider2(registry, { limit: DEFAULT_LIMIT });

  try {
    exportedSearch = Gio.DBusExportedObject.wrapJSObject(SEARCH_XML, searchImpl);
    exportedSearch.export(connection, OBJECT_PATH);
    exportedProvider = Gio.DBusExportedObject.wrapJSObject(
      SEARCH_PROVIDER_XML,
      providerImpl
    );
    exportedProvider.export(connection, OBJECT_PATH);
  } catch (error) {
    printerr(`gnome-spotlightd: cannot export D-Bus objects: ${error.message}`);
    return 1;
  }

  ownerId = Gio.bus_own_name_on_connection(
    connection,
    BUS_NAME,
    Gio.BusNameOwnerFlags.DO_NOT_QUEUE,
    () => {
      nameAcquired = true;
      printerr(`gnome-spotlightd ${VERSION} ready on ${BUS_NAME}`);
    },
    () => {
      if (shuttingDown)
        return;
      if (!nameAcquired) {
        // Another instance already owns the name; leave it running.
        printerr(`gnome-spotlightd: ${BUS_NAME} is already owned, exiting`);
        shutdown(0);
        return;
      }
      printerr(`gnome-spotlightd: lost ${BUS_NAME}, exiting`);
      shutdown(1);
    }
  );

  // SIGTERM/SIGINT should release the bus name before the process disappears.
  for (const signal of [15, 2]) {
    try {
      GLibUnix.signal_add(GLib.PRIORITY_DEFAULT, signal, () => {
        shutdown(0);
        return GLib.SOURCE_REMOVE;
      });
    } catch {
      // Signal handling is best effort; Quit() remains available.
    }
  }

  loop.run();

  for (const provider of registry.list()) {
    try {
      provider.dispose?.();
    } catch {
      // Shutdown is best effort.
    }
  }

  return 0;
}

const exitCode = main(ARGV);
if (exitCode !== 0)
  system.exit(exitCode);