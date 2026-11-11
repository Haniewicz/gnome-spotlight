// org.gnome.Shell.SearchProvider2 adapter. It delegates to the same daemon
// registry as org.gnome.Spotlight.Search; no Shell imports are needed.
import GLib from 'gi://GLib';

import {
  iconToString,
  resultDescription,
  resultPath,
  serializeActions,
} from './serialize.js';

export const SEARCH_PROVIDER_INTERFACE = 'org.gnome.Shell.SearchProvider2';

export const SEARCH_PROVIDER_XML = `
<node>
  <interface name="org.gnome.Shell.SearchProvider2">
    <method name="GetInitialResultSet">
      <arg type="as" name="terms" direction="in"/>
      <arg type="as" name="results" direction="out"/>
    </method>
    <method name="GetSubsearchResultSet">
      <arg type="as" name="previous_results" direction="in"/>
      <arg type="as" name="terms" direction="in"/>
      <arg type="as" name="results" direction="out"/>
    </method>
    <method name="GetResultMetas">
      <arg type="as" name="identifiers" direction="in"/>
      <arg type="aa{sv}" name="metas" direction="out"/>
    </method>
    <method name="ActivateResult">
      <arg type="s" name="identifier" direction="in"/>
      <arg type="as" name="terms" direction="in"/>
      <arg type="u" name="timestamp" direction="in"/>
    </method>
    <method name="LaunchSearch">
      <arg type="as" name="terms" direction="in"/>
      <arg type="u" name="timestamp" direction="in"/>
    </method>
  </interface>
</node>`;

function stringVariant(value) {
  return new GLib.Variant('s', String(value ?? ''));
}

function doubleVariant(value) {
  const number = Number(value);
  return new GLib.Variant('d', Number.isFinite(number) ? number : 0);
}

function adapterId(result) {
  const providerId = String(result.providerId ?? '');
  const id = String(result.id ?? '');
  return providerId === '' ? id : `${providerId}:${id}`;
}

export class SearchProvider2 {
  constructor(registry, options = {}) {
    this._registry = registry;
    this._options = options ?? {};
    this._byId = new Map();
    this._lastResults = [];
  }

  get registry() {
    return this._registry;
  }

  _query(terms) {
    if (Array.isArray(terms))
      return terms.map(term => String(term ?? '')).join(' ').trim();
    return String(terms ?? '').trim();
  }

  _lookup(id) {
    const key = String(id ?? '');
    if (this._byId.has(key))
      return this._byId.get(key);
    if (this._registry && typeof this._registry.getResult === 'function')
      return this._registry.getResult(key);
    return null;
  }

  async _search(terms) {
    const query = this._query(terms);
    const response = await this._registry.search(query, {
      mode: this._options.mode ?? '',
      limit: this._options.limit ?? 8,
      perProviderLimit: this._options.perProviderLimit,
    });

    this._byId.clear();
    this._lastResults = response.results.slice();
    const ids = [];
    for (const result of response.results) {
      const id = adapterId(result);
      if (id === '' || this._byId.has(id))
        continue;
      this._byId.set(id, result);
      ids.push(id);
    }
    return ids;
  }

  /**
   * @param {string[]} terms
   * @returns {Promise<string[]>}
   */
  GetInitialResultSet(terms) {
    return this._search(terms);
  }

  /**
   * @param {string[]} previousResults
   * @param {string[]} terms
   * @returns {Promise<string[]>}
   */
  GetSubsearchResultSet(previousResults, terms) {
    return this._search(terms);
  }

  /**
   * @param {string[]} identifiers
   * @returns {object[]} array of vardict-compatible metadata objects
   */
  GetResultMetas(identifiers) {
    const ids = Array.isArray(identifiers) ? identifiers : [];
    const metas = [];

    for (const rawId of ids) {
      const id = String(rawId ?? '');
      const result = this._lookup(id);
      if (!result) {
        metas.push({
          id: stringVariant(id),
          name: stringVariant(id),
          description: stringVariant(''),
          gicon: stringVariant('application-x-executable-symbolic'),
        });
        continue;
      }

      metas.push({
        id: stringVariant(id),
        name: stringVariant(result.title ?? result.name ?? id),
        description: stringVariant(resultDescription(result)),
        gicon: stringVariant(iconToString(result.icon)),
        // Extra keys are allowed by the aa{sv} contract and let the client
        // reuse the richer daemon metadata without another round trip.
        kind: stringVariant(result.kind ?? ''),
        provider: stringVariant(result.providerId ?? ''),
        score: doubleVariant(result.score),
        path: stringVariant(resultPath(result)),
        actions: stringVariant(serializeActions(result.actions)),
      });
    }

    return metas;
  }

  /**
   * @param {string} identifier
   * @param {string[]} terms
   * @param {number} timestamp
   */
  ActivateResult(identifier, terms, timestamp) {
    const id = String(identifier ?? '');
    if (this._registry && typeof this._registry.activate === 'function') {
      this._registry.activate(id);
      return;
    }

    this._lookup(id);
  }

  /**
   * Native Shell "Search in ..." action. The launcher has no standalone
   * window, so activating the best result is the useful equivalent.
   *
   * @param {string[]} terms
   * @param {number} timestamp
   * @returns {Promise<void>}
   */
  async LaunchSearch(terms, timestamp) {
    const ids = await this._search(terms);
    if (ids.length > 0)
      this.ActivateResult(ids[0], terms, timestamp);
  }
}

export function createSearchProvider2(registry, options = {}) {
  return new SearchProvider2(registry, options);
}

export default SearchProvider2;