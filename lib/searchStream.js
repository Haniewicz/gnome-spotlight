// PURE module: no GI or shell-resource imports.
//
// Frontend-side stream helpers shared by extension.js and lib/ui/modal.js.
// They merge the daemon stream with the Shell-local windows provider, keep the
// visible result set stable across identical responses and provide a small LRU
// cache for the very first paint of a repeated query (DESIGN §13).

import { parseActions } from './action-runner.js';

const DEFAULT_LRU_CAPACITY = 20;
const RESULT_KEY_SEPARATOR = '\u0000';

/**
 * Identity of one result across the daemon/local boundary.
 *
 * @param {object|null|undefined} result
 * @returns {string}
 */
export function resultKey(result) {
  const providerId = result?.providerId ?? '';
  const id = result?.id;
  return `${providerId}${RESULT_KEY_SEPARATOR}${
    id === undefined || id === null ? '' : String(id)
  }`;
}

/**
 * Cache key for one (query, mode) pair. Modes are kept separate so the same
 * text in "files" mode never reuses results from the default mode.
 *
 * @param {string} query
 * @param {string} [mode]
 * @returns {string}
 */
export function cacheKey(query, mode = '') {
  return `${String(mode ?? '')}${RESULT_KEY_SEPARATOR}${String(query ?? '')}`;
}

function normalizeLimit(value, fallback = Number.POSITIVE_INFINITY) {
  if (value === undefined || value === null)
    return fallback;
  const number = Number(value);
  if (!Number.isFinite(number))
    return fallback;
  return Math.max(0, Math.floor(number));
}

function isWindowsResult(result) {
  return String(result?.providerId ?? '') === 'windows';
}

/**
 * Merge daemon results with Shell-local results.
 *
 * Identity is `providerId + id`. A local Shell result wins over a daemon
 * result for the same identity only when it is a windows result (windows can
 * only be enumerated inside gnome-shell). Daemon order is preserved; local
 * additions are appended. The merged list is truncated to `limit` items.
 *
 * @param {object[]} daemonResults
 * @param {object[]} localResults
 * @param {{limit?: number}} [options]
 * @returns {object[]}
 */
export function mergeSources(daemonResults, localResults, options = {}) {
  const limit = normalizeLimit(options?.limit);
  if (limit === 0)
    return [];

  const daemon = Array.isArray(daemonResults) ? daemonResults : [];
  const local = Array.isArray(localResults) ? localResults : [];
  const merged = [];
  const positions = new Map();

  for (const result of daemon) {
    if (!result || typeof result !== 'object')
      continue;

    const key = resultKey(result);
    if (positions.has(key))
      continue;

    positions.set(key, merged.length);
    merged.push(result);
  }

  for (const result of local) {
    if (!result || typeof result !== 'object')
      continue;

    const key = resultKey(result);
    const position = positions.get(key);
    if (position !== undefined) {
      // The Shell is the only reliable source for open windows. When both
      // streams describe the same window, the Shell copy wins the tie.
      if (isWindowsResult(result))
        merged[position] = result;
      continue;
    }

    positions.set(key, merged.length);
    merged.push(result);
  }

  return merged.slice(0, limit);
}

function sameIdentityOrder(previous, next) {
  for (let i = 0; i < previous.length; i++) {
    if (resultKey(previous[i]) !== resultKey(next[i]))
      return false;
  }
  return true;
}

function sameIdentitySet(previous, next) {
  if (previous.length !== next.length)
    return false;

  const keys = new Set(previous.map(resultKey));
  if (keys.size !== previous.length)
    return false;

  for (const result of next) {
    const key = resultKey(result);
    if (!keys.has(key))
      return false;
    keys.delete(key);
  }

  return keys.size === 0;
}

/**
 * Avoid rebuilding rows when two streams describe the same result set in the
 * same order. Identity (providerId + id) is what the modal pools rows by, so
 * an identical ordered set returns the previous array reference even if
 * metadata changed. A reordered set returns the incoming array: ranking
 * updates (e.g. a frecency boost after the user picks a result) must be
 * visible instead of being swallowed as "same rows".
 *
 * @template T
 * @param {T[]|null|undefined} previous
 * @param {T[]|null|undefined} next
 * @returns {T[]}
 */
export function stabilize(previous, next) {
  const current = Array.isArray(previous) ? previous : null;
  const incoming = Array.isArray(next) ? next : [];

  if (current && sameIdentitySet(current, incoming) &&
      sameIdentityOrder(current, incoming))
    return previous;

  return incoming;
}

/**
 * Minimal LRU cache. A lookup refreshes recency; adding the 21st entry evicts
 * the least recently used one.
 */
export class LruCache {
  constructor(capacity = DEFAULT_LRU_CAPACITY) {
    const value = Number(capacity);
    this._capacity = Number.isFinite(value) && value > 0
      ? Math.floor(value)
      : DEFAULT_LRU_CAPACITY;
    this._entries = new Map();
  }

  get capacity() {
    return this._capacity;
  }

  get size() {
    return this._entries.size;
  }

  remember(key, value) {
    if (key === undefined || key === null)
      return value;

    const normalized = String(key);
    if (this._entries.has(normalized))
      this._entries.delete(normalized);
    this._entries.set(normalized, value);

    while (this._entries.size > this._capacity) {
      const oldest = this._entries.keys().next().value;
      this._entries.delete(oldest);
    }

    return value;
  }

  lookup(key) {
    if (key === undefined || key === null)
      return undefined;

    const normalized = String(key);
    if (!this._entries.has(normalized))
      return undefined;

    const value = this._entries.get(normalized);
    this._entries.delete(normalized);
    this._entries.set(normalized, value);
    return value;
  }

  has(key) {
    return this._entries.has(String(key));
  }

  clear() {
    this._entries.clear();
  }
}

export function createLruCache(capacity = DEFAULT_LRU_CAPACITY) {
  return new LruCache(capacity);
}

// Module-level cache used by the modal; one extension instance means one
// launcher, so a shared 20-entry cache is enough.
const defaultCache = new LruCache(DEFAULT_LRU_CAPACITY);

export function remember(key, value) {
  return defaultCache.remember(key, value);
}

export function lookup(key) {
  return defaultCache.lookup(key);
}

export function clearCache() {
  defaultCache.clear();
}

/**
 * Normalize the `actions` field of one result at the stream boundary.
 *
 * `GLib.Variant` values from D-Bus are unwrapped by `parseActions()`, so the
 * modal, preview and action menu always receive the same plain descriptor
 * shape regardless of whether the result came from the daemon, a D-Bus test
 * or an in-process provider. Mutates and returns the same result object.
 *
 * @param {object|null|undefined} result
 * @returns {object|null|undefined}
 */
export function normalizeResultActions(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result))
    return result;
  if (!Object.prototype.hasOwnProperty.call(result, 'actions'))
    return result;

  const raw = result.actions;
  if (raw === null || raw === undefined)
    return result;

  result.actions = parseActions(raw);
  return result;
}

/**
 * Normalize a source response to the shape consumed by the modal.
 *
 * @param {*} response
 * @param {string} source
 * @returns {{results: object[], stats: object, source: string, errors?: object[]}}
 */
export function normalizeResponse(response, source) {
  const results = Array.isArray(response?.results) ? response.results : [];
  for (const result of results)
    normalizeResultActions(result);
  const stats = response?.stats && typeof response.stats === 'object'
    ? response.stats
    : {};
  const normalized = { results, stats, source };
  if (Array.isArray(response?.errors))
    normalized.errors = response.errors;
  return normalized;
}

function safeWindows(localWindows, query, options) {
  if (typeof localWindows !== 'function')
    return Promise.resolve([]);

  return Promise.resolve()
    .then(() => localWindows(query, options))
    .then(results => Array.isArray(results) ? results : [])
    .catch(() => []);
}

/**
 * The daemon branch of `SpotlightExtension._onSearchChanged`.
 *
 * The daemon search and the Shell-local windows provider run in parallel. If
 * the daemon is timed out, unavailable or erroring, the in-process registry is
 * used as an offline fallback; a cancelled request never falls back because a
 * newer keystroke already owns the modal.
 *
 * @param {object} options
 * @param {string} options.query
 * @param {string} [options.mode]
 * @param {number} [options.limit]
 * @param {(query: string, options: object) => Promise<object>} options.daemonSearch
 * @param {(query: string, options: object) => Promise<object[]>} [options.localWindows]
 * @param {(query: string, options: object) => Promise<object>} [options.fallbackSearch]
 * @returns {Promise<{results: object[], stats: object, source: string}>}
 */
export async function searchDaemonSources({
  query,
  mode = '',
  limit = 8,
  daemonSearch,
  localWindows = null,
  fallbackSearch = null,
}) {
  const searchOptions = { mode, limit };
  const daemonPromise = Promise.resolve()
    .then(() => daemonSearch(String(query ?? ''), searchOptions))
    .catch(() => ({ results: [], stats: {}, source: 'error' }));
  const windowsPromise = safeWindows(localWindows, String(query ?? ''), searchOptions);

  const [daemon, windows] = await Promise.all([daemonPromise, windowsPromise]);
  const daemonResponse = normalizeResponse(daemon, daemon?.source ?? 'error');

  if (daemonResponse.source === 'daemon') {
    return {
      results: mergeSources(daemonResponse.results, windows, { limit }),
      stats: daemonResponse.stats,
      source: 'daemon',
    };
  }

  if (daemonResponse.source === 'cancelled') {
    return {
      results: [],
      stats: {},
      source: 'offline',
      cancelled: true,
    };
  }

  if (typeof fallbackSearch === 'function') {
    try {
      const fallback = await fallbackSearch(String(query ?? ''), searchOptions);
      return normalizeResponse(fallback, 'offline');
    } catch {
      // The modal still gets a valid offline response; the next keystroke
      // can retry the local registry.
      return {
        results: mergeSources([], windows, { limit }),
        stats: {},
        source: 'offline',
      };
    }
  }

  return {
    results: mergeSources([], windows, { limit }),
    stats: {},
    source: 'offline',
  };
}

export default {
  cacheKey,
  clearCache,
  createLruCache,
  lookup,
  mergeSources,
  normalizeResponse,
  normalizeResultActions,
  remember,
  resultKey,
  searchDaemonSources,
  stabilize,
};