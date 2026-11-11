// PURE module: no GI or shell-resource imports.
import { scoreResult } from '../ranking.js';

export const ProviderPriority = Object.freeze({
  HIGH: 0,
  NORMAL: 10,
  LOW: 20,
});

const DEFAULT_TIMEOUT_MS = 300;
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
  constructor() {
    this._providers = [];
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
    const startedAt = Date.now();
    const timeoutMs = normalizeTimeout(provider.timeoutMs);
    let timer = null;
    let timedOut = false;

    const timeoutPromise = new Promise((_resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        reject(new Error(`provider ${provider.id} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
    });

    // Promise.resolve().then() turns a synchronous throw into a rejection
    // and guarantees that the timeout timer is already armed.
    const searchPromise = Promise.resolve()
      .then(() => provider.search(providerQuery, context));

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
        timings[provider.id] = Date.now() - startedAt;
      });
  }

  /**
   * Search all matching providers in parallel.
   *
   * @param {string} query
   * @returns {Promise<{results: object[], errors: object[], timings: object}>}
   */
  async search(query) {
    const trimmed = String(query ?? '').trim();
    const errors = [];
    const timings = {};
    const selection = this._selectProviders(trimmed);

    if (selection.length === 0)
      return { results: [], errors, timings };

    const context = {
      registry: this,
      query: trimmed,
      originalQuery: trimmed,
      errors,
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

    const now = Date.now();
    for (const entry of unique)
      entry.score = scoreResult(entry.providerQuery, entry.result, null, now);

    unique.sort((a, b) => {
      const priorityA = normalizePriority(a.provider.priority);
      const priorityB = normalizePriority(b.provider.priority);
      if (priorityA !== priorityB)
        return priorityA - priorityB;

      if (b.score !== a.score)
        return b.score - a.score;

      const titleOrder = String(a.result.title ?? '')
        .localeCompare(String(b.result.title ?? ''), 'pl');
      if (titleOrder !== 0)
        return titleOrder;

      return a.order - b.order;
    });

    return {
      results: unique.map(entry => entry.result),
      errors,
      timings,
    };
  }
}

export function createRegistry() {
  return new ProviderRegistry();
}

export default ProviderRegistry;