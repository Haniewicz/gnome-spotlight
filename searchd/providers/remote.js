// Client for GNOME Shell's native org.gnome.Shell.SearchProvider2 services.
//
// The daemon discovers provider descriptors from the standard
// gnome-shell/search-providers directories and queries every provider in
// parallel. Each D-Bus call is asynchronous and raced against its own timeout,
// so one missing or hung application never blocks the launcher.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import { discoverProviders, parseSearchProviderIni } from '../../lib/search-providers-ini.js';
import { scoreResult } from '../../lib/ranking.js';
import { ProviderPriority } from '../../lib/providers/registry.js';

const PROVIDER_ID = 'remote';
export const SEARCH_PROVIDER_INTERFACE = 'org.gnome.Shell.SearchProvider2';
const OWN_BUS_NAME = 'org.gnome.Spotlight';
const DEFAULT_TIMEOUT_MS = 150;
const DEFAULT_LIMIT = 8;
const DEFAULT_FAILURE_COOLDOWN_MS = 30 * 1000;
const USER_SEARCH_PROVIDER_DIR = 'gnome-shell/search-providers';
const SYSTEM_SEARCH_PROVIDER_DIR = '/usr/share/gnome-shell/search-providers';

export const REMOTE_PROVIDER_ID = PROVIDER_ID;
export const REMOTE_CALL_TIMEOUT_MS = DEFAULT_TIMEOUT_MS;
export const NATIVE_KIND = 'Natywne';

function asList(value) {
  if (value === undefined || value === null)
    return [];
  return Array.isArray(value) ? value : [value];
}

function isIniPath(value) {
  return /\.ini$/i.test(String(value ?? ''));
}

function joinPath(base, name) {
  return String(base).replace(/\/+$/, '') + '/' + String(name).replace(/^\/+/, '');
}

function decode(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  } catch {
    try {
      return String(bytes);
    } catch {
      return '';
    }
  }
}

function listIniFiles(directory) {
  const dir = String(directory ?? '');
  if (dir === '')
    return [];

  let enumerator = null;
  try {
    enumerator = Gio.File.new_for_path(dir).enumerate_children(
      'standard::name,standard::type',
      Gio.FileQueryInfoFlags.NONE,
      null
    );
  } catch {
    return [];
  }

  const paths = [];
  try {
    let info = null;
    while ((info = enumerator.next_file(null)) !== null) {
      const name = String(info.get_name() ?? '');
      if (name !== '' && isIniPath(name))
        paths.push(joinPath(dir, name));
    }
  } catch {
    // A partially readable directory still contributes its readable files.
  } finally {
    try {
      enumerator.close(null);
    } catch {
      // The enumerator may already be closed.
    }
  }

  return paths.sort();
}

function expandSearchProviderPaths(value) {
  const paths = [];
  for (const entry of asList(value)) {
    const text = String(entry ?? '').trim();
    if (text === '')
      continue;
    if (isIniPath(text))
      paths.push(text);
    else
      paths.push(...listIniFiles(text));
  }
  return paths;
}

function readIniFile(path) {
  try {
    const [ok, contents] = GLib.file_get_contents(String(path));
    if (!ok)
      return null;
    const parsed = parseSearchProviderIni(decode(contents));
    if (!parsed || parsed.busName === '' || parsed.objectPath === '')
      return null;
    return {
      ...parsed,
      file: String(path),
      desktopId: parsed.desktopId || parsed.busName,
    };
  } catch {
    return null;
  }
}

function normalizeProvider(raw) {
  if (typeof raw === 'string') {
    if (isIniPath(raw))
      return readIniFile(raw);
    return parseSearchProviderIni(raw);
  }
  if (!raw || typeof raw !== 'object')
    return null;

  const busName = String(raw.busName ?? raw.bus ?? '').trim();
  const objectPath = String(raw.objectPath ?? raw.path ?? '').trim();
  if (busName === '' || objectPath === '')
    return null;

  return {
    desktopId: String(raw.desktopId ?? raw.desktop ?? busName),
    busName,
    objectPath,
    version: Number.isFinite(Number(raw.version)) ? Number(raw.version) : 2,
    autoStart: raw.autoStart === true ||
      ['true', 'yes', 'on', '1'].includes(String(raw.autoStart ?? '').toLowerCase()),
    file: raw.file ? String(raw.file) : '',
  };
}

function defaultUserDir() {
  try {
    return joinPath(GLib.get_user_data_dir(), USER_SEARCH_PROVIDER_DIR);
  } catch {
    return '';
  }
}

function configKey(config) {
  return `${config.busName}\u0000${config.objectPath}`;
}

function isOwnProvider(config) {
  return config.busName === OWN_BUS_NAME ||
    config.busName.startsWith(`${OWN_BUS_NAME}.`);
}

function loadConfigs(options) {
  const raw = [];

  const explicit = options.providers ?? options.searchProviders ??
    options.iniPaths ?? options.providerPaths ?? options.paths;
  if (explicit !== undefined)
    raw.push(...asList(explicit));
  if (Array.isArray(options.providerIni))
    raw.push(...options.providerIni);

  if (explicit === undefined && options.providerIni === undefined) {
    const hasExplicitDirectories = options.userDir !== undefined ||
      options.systemDir !== undefined ||
      options.searchProviderDirs !== undefined;
    const explicitDirs = options.searchProviderDirs;

    let userEntries;
    let systemEntries;
    if (hasExplicitDirectories) {
      userEntries = options.userDir !== undefined
        ? expandSearchProviderPaths(options.userDir)
        : explicitDirs !== undefined
          ? expandSearchProviderPaths(explicitDirs)
          : [];
      systemEntries = options.systemDir !== undefined
        ? expandSearchProviderPaths(options.systemDir)
        : [];
    } else {
      userEntries = listIniFiles(defaultUserDir());
      systemEntries = listIniFiles(SYSTEM_SEARCH_PROVIDER_DIR);
    }

    for (const path of discoverProviders({
      userDir: userEntries,
      systemDir: systemEntries,
    }))
      raw.push(path);

    // discoverProviders keeps only .ini paths; for callers that passed an
    // explicit directory this is already the complete list.
    if (raw.length === 0)
      raw.push(...userEntries, ...systemEntries);
  }

  const configs = [];
  const seen = new Set();
  for (const entry of raw) {
    const config = normalizeProvider(entry);
    if (!config || isOwnProvider(config))
      continue;

    const key = configKey(config);
    if (seen.has(key))
      continue;
    seen.add(key);
    configs.push(config);
  }
  return configs;
}

function unpack(value, depth = 0) {
  if (depth > 4 || value === null || value === undefined)
    return value;
  try {
    if (typeof value.deep_unpack === 'function')
      return unpack(value.deep_unpack(), depth + 1);
    if (typeof value.unpack === 'function')
      return unpack(value.unpack(), depth + 1);
  } catch {
    return value;
  }
  return value;
}

function firstReplyValue(reply) {
  const value = unpack(reply);
  // A D-Bus reply is a one-element tuple. Fake connections used by tests may
  // hand back the payload directly, so only unwrap when the first element is
  // itself the result array (as) / array of vardicts (aa{sv}).
  if (Array.isArray(value) && value.length === 1 && Array.isArray(value[0]))
    return value[0];
  return value;
}

function toStringArray(value) {
  const unpacked = unpack(value);
  if (!Array.isArray(unpacked))
    return [];
  return unpacked
    .map(entry => String(unpack(entry) ?? ''))
    .filter(entry => entry !== '');
}

function metaDict(meta) {
  const value = unpack(meta);
  if (!value || typeof value !== 'object')
    return {};
  if (value instanceof Map)
    return Object.fromEntries(value.entries());
  return value;
}

function metaValue(meta, names) {
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(meta, name))
      return unpack(meta[name]);
    if (Object.prototype.hasOwnProperty.call(meta, `_${name}`))
      return unpack(meta[`_${name}`]);
  }
  return undefined;
}

function stringValue(value, fallback = '') {
  const unpacked = unpack(value);
  if (unpacked === null || unpacked === undefined)
    return fallback;
  if (typeof unpacked === 'string')
    return unpacked;
  if (typeof unpacked === 'number' || typeof unpacked === 'boolean')
    return String(unpacked);
  return fallback;
}

/**
 * GNOME providers serialize themed icons as `('themed', ['name', ...])`.
 * Convert the common forms to a plain icon name; anything unknown falls back
 * to the generic executable icon rather than leaking a non-string to D-Bus.
 */
export function iconNameFromMeta(value) {
  const fallback = 'application-x-executable-symbolic';
  const icon = unpack(value);
  if (icon === null || icon === undefined || icon === '')
    return fallback;
  if (typeof icon === 'string')
    return icon || fallback;
  if (typeof icon.to_string === 'function') {
    try {
      return String(icon.to_string()) || fallback;
    } catch {
      return fallback;
    }
  }
  if (Array.isArray(icon)) {
    const [kind, payload] = icon;
    if (kind === 'themed') {
      const names = unpack(payload);
      if (Array.isArray(names) && names.length > 0)
        return stringValue(names[0], fallback) || fallback;
      return stringValue(names, fallback) || fallback;
    }
    if (kind === 'file')
      return stringValue(payload, fallback) || fallback;
    if (typeof kind === 'string' && kind !== '')
      return kind;
  }
  if (typeof icon === 'object') {
    if (typeof icon.name === 'string' && icon.name !== '')
      return icon.name;
    if (icon.themed !== undefined || icon.file !== undefined)
      return iconNameFromMeta(icon.themed ?? icon.file);
  }
  return fallback;
}

function errorReason(error) {
  const message = String(error?.message ?? error ?? '');
  if (error?.reason === 'timeout' ||
      error?.code === Gio.IOErrorEnum?.TIMED_OUT ||
      /tim(?:e|ed)[\s-]*out/i.test(message))
    return 'timeout';
  return 'error';
}

function timestampValue(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0)
    return 0;
  return Math.min(0xffffffff, Math.floor(number));
}

/**
 * Create the daemon-side `remote` provider.
 *
 * Options:
 * - `connection` / `dbus`: optional Gio.DBusConnection (tests inject a fake).
 * - `providers` / `iniPaths` / `paths`: explicit descriptors or .ini paths.
 * - `userDir`, `systemDir`: directories or lists of .ini paths to inspect.
 * - `timeoutMs`: per D-Bus call budget (default 150 ms).
 * - `limit`: maximum results from this provider (default 8).
 * - `failureCooldownMs`: skip a provider that just timed out for this long.
 * - `cacheTtlMs`: optional short-lived per-query cache (default 0/off).
 *
 * @param {object} [options]
 * @returns {object}
 */
export function createProvider(options = {}) {
  const settings = options && typeof options === 'object' ? options : {};
  const now = typeof settings.now === 'function' ? settings.now : Date.now;
  const timeoutMs = Number.isFinite(Number(settings.timeoutMs))
    ? Math.max(1, Math.floor(Number(settings.timeoutMs)))
    : DEFAULT_TIMEOUT_MS;
  const limit = Number.isFinite(Number(settings.limit))
    ? Math.max(0, Math.floor(Number(settings.limit)))
    : DEFAULT_LIMIT;
  const failureCooldownMs = Number.isFinite(Number(settings.failureCooldownMs))
    ? Math.max(0, Math.floor(Number(settings.failureCooldownMs)))
    : DEFAULT_FAILURE_COOLDOWN_MS;
  const cacheTtlMs = Number.isFinite(Number(settings.cacheTtlMs))
    ? Math.max(0, Math.floor(Number(settings.cacheTtlMs)))
    : 0;

  let connection = settings.connection ?? settings.dbus;
  if (connection === undefined) {
    try {
      connection = Gio.DBus.session;
    } catch {
      connection = null;
    }
  }

  const configs = loadConfigs(settings);
  const byBus = new Map();
  for (const config of configs)
    byBus.set(config.busName, config);

  const blockedUntil = new Map();
  const resultsById = new Map();
  const cache = new Map();
  let lastErrors = [];

  function errorsFor(config, stage, error) {
    return {
      providerId: `${PROVIDER_ID}:${config.busName}`,
      busName: config.busName,
      stage,
      reason: errorReason(error),
      message: String(error?.message ?? error ?? 'search provider failed'),
    };
  }

  function isBlocked(config) {
    const until = blockedUntil.get(config.busName) ?? 0;
    if (until === 0)
      return false;
    if (now() >= until) {
      blockedUntil.delete(config.busName);
      return false;
    }
    return true;
  }

  function _call(config, method, parameters, replyType) {
    return new Promise((resolve, reject) => {
      if (!connection || typeof connection.call !== 'function') {
        reject(new Error('session bus unavailable'));
        return;
      }

      let settled = false;
      let timer = null;
      let cancellable = null;

      const finish = (callback, value) => {
        if (settled)
          return;
        settled = true;
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
        callback(value);
      };

      timer = setTimeout(() => {
        const error = new Error(
          `${config.busName} ${method} timed out after ${timeoutMs} ms`
        );
        error.reason = 'timeout';
        try {
          cancellable?.cancel();
        } catch {
          // Cancelling an already finished call is harmless.
        }
        finish(reject, error);
      }, timeoutMs);

      try {
        cancellable = new Gio.Cancellable();
        connection.call(
          config.busName,
          config.objectPath,
          SEARCH_PROVIDER_INTERFACE,
          method,
          parameters,
          replyType,
          Gio.DBusCallFlags.NONE,
          timeoutMs,
          cancellable,
          (source, result) => {
            if (settled)
              return;
            try {
              const reply = source && typeof source.call_finish === 'function'
                ? source.call_finish(result)
                : result;
              finish(resolve, reply);
            } catch (error) {
              finish(reject, error);
            }
          }
        );
      } catch (error) {
        finish(reject, error);
      }
    });
  }

  function metasMap(metas) {
    const map = new Map();
    const list = unpack(metas);
    if (!Array.isArray(list))
      return map;

    for (let index = 0; index < list.length; index++) {
      const meta = metaDict(list[index]);
      const id = stringValue(metaValue(meta, ['id', 'identifier']), '');
      map.set(id === '' ? `#${index}` : id, meta);
    }
    return map;
  }

  function toResult(config, remoteId, meta, terms, query) {
    const name = stringValue(
      metaValue(meta, ['name', 'title']),
      remoteId
    ) || remoteId;
    const description = stringValue(
      metaValue(meta, ['description', 'subtitle']),
      ''
    );
    const icon = iconNameFromMeta(metaValue(meta, ['gicon', 'icon', 'icon-name']));
    const providerId = `${PROVIDER_ID}:${config.busName}`;
    const id = `${config.busName}:${remoteId}`;
    const score = scoreResult(query, { title: name, key: name });

    const result = {
      id,
      providerId,
      provider: providerId,
      title: name,
      name,
      subtitle: description,
      description,
      kind: NATIVE_KIND,
      icon,
      score: Number.isFinite(score) ? score : 0,
      key: name,
      usageKey: `${providerId}:${id}`,
      activation: {
        type: 'remote',
        busName: config.busName,
        objectPath: config.objectPath,
        remoteId,
        terms: terms.slice(),
      },
      remote: {
        busName: config.busName,
        objectPath: config.objectPath,
        remoteId,
      },
      preview: {
        rows: [
          ['Aplikacja', config.busName],
          ['Opis', description || '—'],
        ],
        description,
      },
    };
    resultsById.set(id, {
      config,
      remoteId,
      terms: terms.slice(),
    });
    return result;
  }

  async function searchProvider(config, terms, query) {
    let ids;
    try {
      const reply = await _call(
        config,
        'GetInitialResultSet',
        new GLib.Variant('(as)', [terms]),
        new GLib.VariantType('(as)')
      );
      ids = toStringArray(firstReplyValue(reply));
    } catch (error) {
      lastErrors.push(errorsFor(config, 'initial', error));
      if (errorReason(error) === 'timeout' && failureCooldownMs > 0)
        blockedUntil.set(config.busName, now() + failureCooldownMs);
      return [];
    }

    if (ids.length === 0)
      return [];

    const wanted = ids.slice(0, limit);
    let metas;
    try {
      const reply = await _call(
        config,
        'GetResultMetas',
        new GLib.Variant('(as)', [wanted]),
        new GLib.VariantType('(aa{sv})')
      );
      metas = metasMap(firstReplyValue(reply));
    } catch (error) {
      lastErrors.push(errorsFor(config, 'metas', error));
      if (errorReason(error) === 'timeout' && failureCooldownMs > 0)
        blockedUntil.set(config.busName, now() + failureCooldownMs);
      return [];
    }

    const results = [];
    for (let index = 0; index < wanted.length; index++) {
      const remoteId = wanted[index];
      const meta = metas.get(remoteId) ?? metas.get(`#${index}`) ?? {};
      results.push(toResult(config, remoteId, meta, terms, query));
    }
    return results;
  }

  const provider = {
    id: PROVIDER_ID,
    title: 'Natywne aplikacje',
    priority: ProviderPriority.LOW,
    prefix: null,
    // Each native call has a 150 ms budget; the outer registry budget must
    // cover both stages plus callback scheduling.
    timeoutMs: timeoutMs * 2 + 50,
    get errors() {
      return lastErrors.slice();
    },
    getProviders() {
      return configs.map(config => ({ ...config }));
    },
    getErrors() {
      return lastErrors.slice();
    },
    get nativeProviders() {
      return configs.map(config => ({ ...config }));
    },
    warmUp() {
      // Discovery already happened in the constructor. Keeping the hook makes
      // the provider compatible with the daemon's warm-up loop.
    },
    dispose() {
      cache.clear();
      resultsById.clear();
      blockedUntil.clear();
      lastErrors = [];
    },
    async search(query) {
      const terms = String(query ?? '').trim().split(/\s+/).filter(Boolean);
      if (terms.length === 0 || limit === 0)
        return [];

      const cacheKey = terms.join(' ');
      const cached = cacheTtlMs > 0 ? cache.get(cacheKey) : null;
      if (cached && now() < cached.expires) {
        lastErrors = cached.errors.slice();
        return cached.results.map(result => ({ ...result }));
      }

      lastErrors = [];
      const active = configs.filter(config => !isBlocked(config));
      const settled = await Promise.all(
        active.map(config => searchProvider(config, terms, query))
      );

      const seen = new Set();
      const results = [];
      for (const section of settled) {
        for (const result of section) {
          if (seen.has(result.id))
            continue;
          seen.add(result.id);
          results.push(result);
        }
      }

      results.sort((a, b) =>
        b.score - a.score ||
        String(a.title ?? '').localeCompare(String(b.title ?? ''), 'pl')
      );
      const limited = results.slice(0, limit);

      if (cacheTtlMs > 0) {
        cache.set(cacheKey, {
          expires: now() + cacheTtlMs,
          results: limited.map(result => ({ ...result })),
          errors: lastErrors.slice(),
        });
      }

      return limited;
    },
    /**
     * Activate a result returned by search(). Accepts the full result id
     * (`<BusName>:<remoteId>`), the daemon adapter id and a raw remote id when
     * it is unambiguous.
     *
     * @param {string} id
     * @param {string[]|string} [terms]
     * @param {number} [timestamp]
     * @returns {Promise<boolean>}
     */
    async activate(id, terms = undefined, timestamp = 0) {
      const key = String(id ?? '');
      let record = resultsById.get(key);

      if (!record) {
        let remoteId = key;
        if (remoteId.startsWith(`${PROVIDER_ID}:`))
          remoteId = remoteId.slice(PROVIDER_ID.length + 1);

        for (const config of configs) {
          if (remoteId.startsWith(`${config.busName}:`)) {
            record = {
              config,
              remoteId: remoteId.slice(config.busName.length + 1),
              terms: [],
            };
            break;
          }
        }

        if (!record && byBus.has(key)) {
          record = { config: byBus.get(key), remoteId: '', terms: [] };
        }
      }

      if (!record || record.remoteId === '')
        return false;

      const activationTerms = Array.isArray(terms)
        ? terms.map(term => String(term ?? '')).filter(term => term !== '')
        : typeof terms === 'string' && terms.trim() !== ''
          ? terms.trim().split(/\s+/)
          : record.terms.slice();

      try {
        await _call(
          record.config,
          'ActivateResult',
          new GLib.Variant('(sasu)', [
            record.remoteId,
            activationTerms,
            timestampValue(timestamp),
          ]),
          new GLib.VariantType('()')
        );
        return true;
      } catch (error) {
        lastErrors.push(errorsFor(record.config, 'activate', error));
        return false;
      }
    },
    async activateResult(id, terms = undefined, timestamp = 0) {
      return provider.activate(id, terms, timestamp);
    },
  };

  return provider;
}

export { createProvider as createRemoteProvider };
export default createProvider;
