// PURE module: no GI or shell-resource imports.
//
// Daemon-side registry. It extends the shared provider registry (parallel
// calls, per-provider timeout, dedupe, ranking, limits) with search modes and
// the statistics object exposed over D-Bus.
import { scoreResult } from '../lib/ranking.js';
import { fold } from '../lib/text.js';
import {
  ProviderPriority,
  ProviderRegistry,
} from '../lib/providers/registry.js';

const DEFAULT_MODE = '';
const DEFAULT_LIMIT = 8;
const DEFAULT_PROVIDER_TIMEOUT_MS = 300;

// GSettings switch read by the daemon entry point. Native SearchProvider2
// services are consumed by the `remote` provider only when this is true.
export const REMOTE_PROVIDERS_KEY = 'remote-providers-enabled';
export const REMOTE_PROVIDER_ID = 'remote';

const MODE_PREFIXES = {
  commands: '>',
  files: 'f ',
  ssh: 'ssh ',
  sys: 'sys ',
  snip: 'snip ',
  docker: 'docker ',
};

// ssh/sys/snip/docker are alternative modes of the same `commands` provider.
const MODE_PROVIDER_IDS = {
  ssh: 'commands',
  sys: 'commands',
  snip: 'commands',
  docker: 'commands',
};

function normalizeMode(mode) {
  return String(mode ?? '').trim().toLowerCase();
}

function prefixModeForQuery(query) {
  const value = String(query ?? '').trim();
  const lower = value.toLowerCase();
  for (const [mode, prefix] of Object.entries(MODE_PREFIXES)) {
    if (value.startsWith(prefix) || lower === prefix.trim())
      return mode;
  }
  return '';
}

function stripModePrefix(mode, query) {
  const text = String(query ?? '');
  const prefix = MODE_PREFIXES[mode];
  if (!prefix)
    return text;

  if (text.toLowerCase().startsWith(prefix.toLowerCase()))
    return text.slice(prefix.length).trimStart();
  if (text.trim().toLowerCase() === prefix.trim())
    return '';
  return text;
}

function withMode(provider, mode) {
  if (mode === '')
    return provider;
  return {
    ...provider,
    search: (query, context = {}) =>
      provider.search(query, { ...(context ?? {}), mode }),
  };
}

function normalizeLimit(value, fallback) {
  if (value === undefined || value === null)
    return fallback;
  const number = Number(value);
  if (!Number.isFinite(number))
    return fallback;
  return Math.max(0, Math.floor(number));
}

// The shared provider registry re-ranks rows by title collation, which would
// put "design-reference.png" before "DESIGN.md". The files provider already
// applies the path tie-break; keep that order for the files mode until the
// daemon replaces the score for display.
function compareFileResults(a, b, query) {
  const scoreA = Number.isFinite(Number(a?.score)) ? Number(a.score) : 0;
  const scoreB = Number.isFinite(Number(b?.score)) ? Number(b.score) : 0;
  if (scoreB !== scoreA)
    return scoreB - scoreA;

  const needle = fold(query).trim();
  const singleTerm = needle !== '' && !needle.includes(' ') ? needle : '';
  const nameA = fold(String(a?.title ?? a?.name ?? ''));
  const nameB = fold(String(b?.title ?? b?.name ?? ''));
  const exactA = singleTerm !== '' && nameA === singleTerm ? 1 : 0;
  const exactB = singleTerm !== '' && nameB === singleTerm ? 1 : 0;
  if (exactB !== exactA)
    return exactB - exactA;

  const prefixA = singleTerm !== '' &&
    nameA.startsWith(`${singleTerm}.`) ? 1 : 0;
  const prefixB = singleTerm !== '' &&
    nameB.startsWith(`${singleTerm}.`) ? 1 : 0;
  if (prefixB !== prefixA)
    return prefixB - prefixA;

  if (nameA.length !== nameB.length)
    return nameA.length - nameB.length;

  const pathA = String(a?.path ?? '');
  const pathB = String(b?.path ?? '');
  const depthA = pathA.split('/').filter(Boolean).length;
  const depthB = pathB.split('/').filter(Boolean).length;
  if (depthA !== depthB)
    return depthA - depthB;
  if (pathA.length !== pathB.length)
    return pathA.length - pathB.length;
  return pathA.localeCompare(pathB, 'pl');
}

function scoringQuery(query, mode) {
  const value = String(query ?? '').trim();
  const explicit = normalizeMode(mode);
  const selected = explicit !== '' && MODE_PREFIXES[explicit]
    ? explicit
    : prefixModeForQuery(value);
  if (selected !== '' && MODE_PREFIXES[selected])
    return stripModePrefix(selected, value);
  return value;
}

/**
 * Search registry used by gnome-spotlightd.
 *
 * `search(query, {mode, limit, perProviderLimit})` returns the base registry
 * response plus `stats = {total, truncated, ms}`. Modes select one provider
 * (`apps`, `settings`, `files`, `commands`, `calculator`) while `mode: ''`
 * keeps the normal prefix behaviour.
 */
export class DaemonRegistry extends ProviderRegistry {
  constructor(options = {}) {
    const baseOptions = options && typeof options === 'object' &&
      Object.prototype.hasOwnProperty.call(options, 'usageMap')
      ? options.usageMap
      : null;
    super(baseOptions);

    this._defaultMode = normalizeMode(
      options && typeof options === 'object' ? options.mode : ''
    );
    this._activator = options && typeof options === 'object' &&
      typeof options.activate === 'function'
      ? options.activate
      : null;
    this._lastResults = new Map();

    // Daemon providers default to the same 300 ms budget even when a provider
    // forgot to advertise timeoutMs.
    for (const provider of this._providers) {
      if (!Number.isFinite(Number(provider.timeoutMs)))
        provider.timeoutMs = DEFAULT_PROVIDER_TIMEOUT_MS;
    }
  }

  setActivator(callback) {
    this._activator = typeof callback === 'function' ? callback : null;
    return this;
  }

  get mode() {
    return this._defaultMode;
  }

  set mode(value) {
    this._defaultMode = normalizeMode(value);
  }

  _selectProviders(query, options = {}) {
    const mode = normalizeMode(
      options && typeof options === 'object' && options.mode !== undefined
        ? options.mode
        : this._defaultMode
    );

    if (mode === '' || mode === 'all') {
      const prefixMode = prefixModeForQuery(query);
      if (prefixMode !== '') {
        const providerId = MODE_PROVIDER_IDS[prefixMode] ?? prefixMode;
        const provider = this._providers.find(item => item.id === providerId);
        if (!provider)
          return [];
        return [{
          provider: withMode(provider, prefixMode),
          query: stripModePrefix(prefixMode, query),
        }];
      }
      return super._selectProviders(query, options);
    }

    const providerId = MODE_PROVIDER_IDS[mode] ?? mode;
    const provider = this._providers.find(item => item.id === providerId);
    if (!provider)
      return [];

    return [{
      provider: withMode(provider, mode),
      query: stripModePrefix(mode, query),
    }];
  }

  _remember(results) {
    this._lastResults.clear();
    for (const result of results) {
      const providerId = result.providerId ?? '';
      const id = result.id === undefined || result.id === null ? '' : String(result.id);
      if (id === '')
        continue;

      this._lastResults.set(`${providerId}:${id}`, result);
      if (!this._lastResults.has(id))
        this._lastResults.set(id, result);
    }
  }

  /**
   * Look up a result from the most recent search.
   *
   * @param {string} id plain result id or "provider:id"
   * @returns {object|null}
   */
  getResult(id) {
    const key = String(id ?? '');
    if (this._lastResults.has(key))
      return this._lastResults.get(key);

    // Accept "provider:id" without requiring the caller to know the exact id
    // format (ids themselves may contain a colon).
    for (const result of this._lastResults.values()) {
      if (String(result.id ?? '') === key)
        return result;
    }
    return null;
  }

  /**
   * Activate a result from the most recent search. The actual side effect is
   * injected by the daemon entry point; the registry itself stays PURE.
   *
   * @param {string} id
   * @returns {boolean}
   */
  activate(id) {
    const result = this.getResult(id);
    if (!result)
      return false;
    if (typeof this._activator !== 'function')
      return false;

    this._activator(result);
    return true;
  }

  async search(query, options = {}, maybeLimit = undefined) {
    let searchOptions;
    if (typeof options === 'string') {
      searchOptions = { mode: options };
      if (maybeLimit !== undefined)
        searchOptions.limit = maybeLimit;
    } else if (typeof options === 'number') {
      searchOptions = { limit: options };
    } else if (options && typeof options === 'object') {
      searchOptions = { ...options };
    } else {
      searchOptions = {};
    }

    if (searchOptions.mode === undefined)
      searchOptions.mode = this._defaultMode;
    const mode = normalizeMode(searchOptions.mode);
    searchOptions.mode = mode;

    const limit = normalizeLimit(searchOptions.limit, DEFAULT_LIMIT);
    if (searchOptions.limit === undefined)
      searchOptions.limit = limit;

    const response = await super.search(query, searchOptions);
    const queryForScore = scoringQuery(query, mode);

    const filesOnly = response.results.length > 0 &&
      response.results.every(result =>
        (result.providerId ?? '') === 'files'
      );
    if (mode === 'files' || filesOnly) {
      response.results.sort((a, b) =>
        compareFileResults(a, b, queryForScore)
      );
    }

    for (const result of response.results) {
      result.score = scoreResult(queryForScore, result);
      if (!Number.isFinite(result.score))
        result.score = 0;
    }

    const ms = {};
    for (const [providerId, value] of Object.entries(response.timings ?? {}))
      ms[providerId] = Number.isFinite(Number(value)) ? Number(value) : 0;

    // Providers such as `remote` fan out to several native D-Bus services and
    // keep their own per-service failures. Surface those next to the registry
    // level errors so callers can see which native application failed without
    // losing the healthy providers' results.
    const errors = Array.isArray(response.errors) ? response.errors.slice() : [];
    const errorKeys = new Set(
      errors.map(entry => `${entry?.providerId ?? ''}\u0000${entry?.reason ?? ''}`)
    );
    const activeProviders = new Set(Object.keys(response.timings ?? {}));
    for (const provider of this._providers) {
      if (!activeProviders.has(provider.id) ||
          typeof provider.getErrors !== 'function')
        continue;
      let providerErrors = [];
      try {
        providerErrors = provider.getErrors();
      } catch {
        providerErrors = [];
      }
      if (!Array.isArray(providerErrors))
        continue;
      for (const entry of providerErrors) {
        const key = `${entry?.providerId ?? ''}\u0000${entry?.reason ?? ''}`;
        if (errorKeys.has(key))
          continue;
        errorKeys.add(key);
        errors.push(entry);
      }
    }

    // `remote` fans out to native services that may not be running. They are
    // skipped without an errors entry, so expose the count explicitly.
    let skipped = 0;
    for (const provider of this._providers) {
      if (!activeProviders.has(provider.id))
        continue;
      let value = 0;
      try {
        value = typeof provider.getSkipped === 'function'
          ? provider.getSkipped()
          : provider.skipped;
      } catch {
        value = 0;
      }
      const count = Number(value);
      if (Number.isFinite(count) && count > 0)
        skipped += Math.floor(count);
    }

    const stats = {
      total: response.totalMatched,
      truncated: response.truncated,
      ms,
      errors,
      skipped,
    };

    this._remember(response.results);

    return {
      ...response,
      stats,
    };
  }
}

export function createDaemonRegistry(options = {}) {
  return new DaemonRegistry(options);
}

export function createRegistry(options = {}) {
  return new DaemonRegistry(options);
}

export { ProviderPriority, ProviderRegistry, DEFAULT_PROVIDER_TIMEOUT_MS };
export default DaemonRegistry;