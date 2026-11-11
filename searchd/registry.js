// PURE module: no GI or shell-resource imports.
//
// Daemon-side registry. It extends the shared provider registry (parallel
// calls, per-provider timeout, dedupe, ranking, limits) with search modes and
// the statistics object exposed over D-Bus.
import { scoreResult } from '../lib/ranking.js';
import {
  ProviderPriority,
  ProviderRegistry,
} from '../lib/providers/registry.js';

const DEFAULT_MODE = '';
const DEFAULT_LIMIT = 8;
const DEFAULT_PROVIDER_TIMEOUT_MS = 300;

const MODE_PREFIXES = {
  commands: '>',
  files: 'f ',
};

function normalizeMode(mode) {
  return String(mode ?? '').trim().toLowerCase();
}

function stripModePrefix(mode, query) {
  const prefix = MODE_PREFIXES[mode];
  if (!prefix || !query.startsWith(prefix))
    return query;
  return query.slice(prefix.length).trimStart();
}

function normalizeLimit(value, fallback) {
  if (value === undefined || value === null)
    return fallback;
  const number = Number(value);
  if (!Number.isFinite(number))
    return fallback;
  return Math.max(0, Math.floor(number));
}

function scoringQuery(query, mode) {
  const value = String(query ?? '').trim();
  if (mode === 'commands' || value.startsWith('>'))
    return value.replace(/^>\s*/, '');
  if (mode === 'files' || value.startsWith('f '))
    return value.replace(/^f\s+/, '');
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

    if (mode === '' || mode === 'all')
      return super._selectProviders(query, options);

    const provider = this._providers.find(item => item.id === mode);
    if (!provider)
      return [];

    return [{ provider, query: stripModePrefix(mode, query) }];
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

    for (const result of response.results) {
      result.score = scoreResult(queryForScore, result);
      if (!Number.isFinite(result.score))
        result.score = 0;
    }

    const ms = {};
    for (const [providerId, value] of Object.entries(response.timings ?? {}))
      ms[providerId] = Number.isFinite(Number(value)) ? Number(value) : 0;

    const stats = {
      total: response.totalMatched,
      truncated: response.truncated,
      ms,
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