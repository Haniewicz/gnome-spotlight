// PURE module: no GI or shell-resource imports.
import { rankResults } from '../ranking.js';

export const ProviderPriority = Object.freeze({
  HIGH: 0,
  NORMAL: 10,
  LOW: 20,
});

const DEFAULT_TIMEOUT_MS = 300;
const DEFAULT_LIMIT = 8;
// Prefixes owned by the launcher itself. A query starting with one of them
// must never leak to plain providers, even when that provider is disabled.
const RESERVED_PREFIXES = ['>'];

function normalizePriority(priority) {
  const value = Number(priority);
  return Number.isFinite(value) ? value : ProviderPriority.NORMAL;
}

function normalizeTimeout(timeoutMs) {
  const value = Number(timeoutMs);
  if (!Number.isFinite(value) || value < 0)
    return DEFAULT_TIMEOUT_MS;
  return value;
}

function normalizeLimit(value, fallback) {
  if (value === undefined || value === null)
    return fallback;
  const number = Number(value);
  if (!Number.isFinite(number))
    return fallback;
  return Math.max(0, Math.floor(number));
}

function isUsageMapLike(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return false;
  if (value instanceof Map)
    return true;
  if (typeof value.entry === 'function' || typeof value.get === 'function')
    return true;
  return Object.values(value).some(entry =>
    entry && typeof entry === 'object' &&
    ('count' in entry || 'lastUsed' in entry));
}

function resultKey(result) {
  const providerId = result?.providerId ?? '';
  const id = result?.id;
  return `${providerId}\u0000${id === undefined || id === null ? '' : String(id)}`;
}

/**
 * Registry of search providers.
 *
 * All providers matching the query are started in parallel and individually
 * raced against their timeout. A failing or slow provider is reported in
 * `errors` and never blocks the rest of the search (DESIGN §4).
 */
export class ProviderRegistry {
  /**
   * @param {object|{usageMap?: object}} [usageMap] plain map, UsageStore or
   *   an options object with a usageMap property
   */
  constructor(usageMap = null) {
    this._providers = [];
    this._usageMap = null;
    this.setUsageMap(usageMap);
  }

  /**
   * Replace the usage source used for frecency boosts. Accepts a plain object,
   * a Map, a UsageStore (it exposes entry()) or null.
   *
   * @param {object|null} usageMap
   * @returns {ProviderRegistry}
   */
  setUsageMap(usageMap = null) {
    if (
      usageMap &&
      typeof usageMap === 'object' &&
      !Array.isArray(usageMap) &&
      Object.prototype.hasOwnProperty.call(usageMap, 'usageMap')
    ) {
      this._usageMap = usageMap.usageMap ?? null;
    } else {
      this._usageMap = usageMap ?? null;
    }
    return this;
  }

  get usageMap() {
    return this._usageMap;
  }

  set usageMap(value) {
    this.setUsageMap(value);
  }

  /**
   * Add a provider. Registering an id twice replaces the previous provider
   * in place, so ids stay unique.
   *
   * @param {object} provider
   * @returns {ProviderRegistry}
   */
  register(provider) {
    if (!provider || typeof provider !== 'object')
      throw new TypeError('provider must be an object');
    if (typeof provider.id !== 'string' || provider.id === '')
      throw new TypeError('provider.id must be a non-empty string');
    if (typeof provider.search !== 'function')
      throw new TypeError(`provider ${provider.id}: search must be a function`);

    const existing = this._providers.findIndex(item => item.id === provider.id);
    if (existing >= 0)
      this._providers[existing] = provider;
    else
      this._providers.push(provider);

    return this;
  }

  /**
   * Remove a provider by id.
   *
   * @param {string} id
   * @returns {boolean} true when a provider was removed
   */
  unregister(id) {
    const index = this._providers.findIndex(provider => provider.id === id);
    if (index < 0)
      return false;
    this._providers.splice(index, 1);
    return true;
  }

  /**
   * Return a copy of the provider list. Mutating the returned array never
   * changes the registry.
   *
   * @returns {object[]}
   */
  list() {
    return this._providers.slice();
  }

  /**
   * Pick providers participating in this query and compute the query each
   * one receives. A consumed prefix is stripped and only the prefixed
   * provider(s) are called; plain providers never see the raw prefixed text.
   *
   * @param {string} query
   * @returns {{provider: object, query: string}[]}
   */
  _selectProviders(query) {
    const prefixed = [];
    for (const provider of this._providers) {
      const prefix = typeof provider.prefix === 'string' ? provider.prefix : '';
      if (prefix !== '' && query.startsWith(prefix))
        prefixed.push({ provider, query: query.slice(prefix.length) });
    }

    if (prefixed.length > 0)
      return prefixed;

    if (RESERVED_PREFIXES.some(prefix => query.startsWith(prefix)))
      return [];

    return this._providers
      .filter(provider => !provider.prefix)
      .map(provider => ({ provider, query }));
  }

  _searchOne(provider, providerQuery, context, errors, timings) {
    const timeoutMs = normalizeTimeout(provider.timeoutMs);

    // Each provider is started from its own microtask. This keeps a slow
    // synchronous provider from charging its runtime to the providers that
    // merely happened to be scheduled before it, so timings describe the
    // provider itself rather than the shared Promise.all window.
    return Promise.resolve().then(() => {
      const startedAt = Date.now();
      let timer = null;
      let timedOut = false;
      let searchPromise;

      const timeoutPromise = new Promise((_resolve, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          reject(new Error(`provider ${provider.id} timed out after ${timeoutMs} ms`));
        }, timeoutMs);
      });

      try {
        searchPromise = Promise.resolve(provider.search(providerQuery, context));
      } catch (error) {
        // A synchronous throw is still a provider error, never a registry
        // crash.
        searchPromise = Promise.reject(error);
      }

      return Promise.race([searchPromise, timeoutPromise])
        .then(value => {
          if (Array.isArray(value))
            return value;
          if (value === null || value === undefined)
            return [];
          return [value];
        })
        .catch(() => {
          errors.push({
            providerId: provider.id,
            reason: timedOut ? 'timeout' : 'error',
          });
          return [];
        })
        .finally(() => {
          // The timer must be cleared on success, error and timeout alike.
          if (timer !== null) {
            clearTimeout(timer);
            timer = null;
          }
          timings[provider.id] = Math.max(0, Date.now() - startedAt);
        });
    });
  }

  /**
   * Search all matching providers in parallel.
   *
   * `limit` caps the total number of returned results and `perProviderLimit`
   * caps one provider section. Both are applied after ranking, so the results
   * that survive are the highest-scored ones, never an arbitrary prefix of the
   * provider output.
   *
   * @param {string} query
   * @param {{usageMap?: object, limit?: number, perProviderLimit?: number}} [options]
   * @returns {Promise<{
   *   results: object[], errors: object[], timings: object,
   *   totalMatched: number, truncated: boolean
   * }>}
   */
  async search(query, options = {}) {
    const trimmed = String(query ?? '').trim();
    const optionsObject = options && typeof options === 'object' ? options : {};
    const limit = normalizeLimit(optionsObject.limit, DEFAULT_LIMIT);
    const perProviderLimit = normalizeLimit(
      optionsObject.perProviderLimit,
      limit
    );

    let usageMap = this._usageMap;
    if (options && typeof options === 'object') {
      if (Object.prototype.hasOwnProperty.call(options, 'usageMap'))
        usageMap = options.usageMap ?? null;
      else if (isUsageMapLike(options))
        usageMap = options;
    }

    const errors = [];
    const timings = {};
    const selection = this._selectProviders(trimmed);

    if (selection.length === 0) {
      return {
        results: [],
        errors,
        timings,
        totalMatched: 0,
        truncated: false,
      };
    }

    const context = {
      registry: this,
      query: trimmed,
      originalQuery: trimmed,
      errors,
      limit,
    };

    const providerResults = await Promise.all(
      selection.map(({ provider, query: providerQuery }) =>
        this._searchOne(
          provider,
          providerQuery,
          { ...context, query: providerQuery },
          errors,
          timings
        ))
    );

    const entries = [];
    let order = 0;

    for (let i = 0; i < selection.length; i++) {
      const { provider, query: providerQuery } = selection[i];
      const results = providerResults[i] ?? [];

      for (const original of results) {
        if (!original || typeof original !== 'object')
          continue;

        const result = { ...original };
        if (!result.providerId)
          result.providerId = provider.id;

        entries.push({
          result,
          provider,
          providerQuery,
          order: order++,
        });
      }
    }

    // Dedupe by providerId + id; the first occurrence wins. Providers are
    // merged in registration order, which keeps the outcome deterministic
    // even though searches finish at different times.
    const seen = new Set();
    const unique = [];
    for (const entry of entries) {
      const key = resultKey(entry.result);
      if (seen.has(key))
        continue;
      seen.add(key);
      unique.push(entry);
    }

    // Provider priority determines the section order; inside one priority the
    // shared ranking (including frecency from usageMap) determines the order.
    const byPriority = new Map();
    for (const entry of unique) {
      const priority = normalizePriority(entry.provider.priority);
      if (!byPriority.has(priority))
        byPriority.set(priority, []);
      byPriority.get(priority).push(entry);
    }

    const ordered = [];
    for (const priority of [...byPriority.keys()].sort((a, b) => a - b)) {
      const group = byPriority.get(priority);
      const queryForGroup = group[0].providerQuery;
      const ranked = rankResults(
        queryForGroup,
        group.map(entry => entry.result),
        usageMap
      );
      const position = new Map(ranked.map((result, index) => [result, index]));

      group.sort((a, b) => {
        const positionA = position.get(a.result) ?? 0;
        const positionB = position.get(b.result) ?? 0;
        return positionA - positionB || a.order - b.order;
      });

      ordered.push(...group);
    }

    // `ordered` is already in final display order. Walk it once and keep the
    // best entries while honouring both caps, so truncation never changes the
    // ranking of the results that remain.
    const totalMatched = ordered.length;
    const kept = [];
    const sectionCounts = new Map();

    for (const entry of ordered) {
      if (kept.length >= limit)
        break;

      const sectionKey = entry.result.providerId ?? '';
      const sectionCount = sectionCounts.get(sectionKey) ?? 0;
      if (sectionCount >= perProviderLimit)
        continue;

      sectionCounts.set(sectionKey, sectionCount + 1);
      kept.push(entry);
    }

    return {
      results: kept.map(entry => entry.result),
      errors,
      timings,
      totalMatched,
      truncated: kept.length < totalMatched,
    };
  }
}

export function createRegistry(usageMap = null) {
  return new ProviderRegistry(usageMap);
}

export default ProviderRegistry;
