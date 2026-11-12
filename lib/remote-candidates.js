// PURE module: no GI or shell-resource imports.
//
// Pure candidate selection for GNOME Shell SearchProvider2 services.
//
// The daemon performs the D-Bus side effects (NameHasOwner probes, proxy
// construction and calls); this module only decides which providers may be
// queried, in which order, and how many results may survive. Keeping it PURE
// makes the no-autostart contract testable without a session bus.

const DEFAULT_LIMIT = 3;

function asArray(value) {
  if (Array.isArray(value))
    return value;
  if (value === undefined || value === null)
    return [];
  if (typeof value[Symbol.iterator] === 'function' &&
      typeof value !== 'string')
    return [...value];
  return [value];
}

function normalizeLimit(value, fallback = DEFAULT_LIMIT) {
  if (value === undefined || value === null)
    return fallback;
  const number = Number(value);
  if (!Number.isFinite(number))
    return fallback;
  return Math.max(0, Math.floor(number));
}

function providerBusName(provider) {
  if (typeof provider === 'string')
    return provider.trim();
  if (!provider || typeof provider !== 'object')
    return '';
  return String(provider.busName ?? provider.bus ?? provider.name ?? '').trim();
}

function ownerValue(value, now) {
  if (value === true || value === 1 || value === 'true' || value === 'yes')
    return true;
  if (value === false || value === 0 || value === 'false' || value === 'no')
    return false;
  if (!value || typeof value !== 'object')
    return false;

  // A cached NameHasOwner result may carry its own expiry. Stale entries are
  // treated as "no owner" and therefore skipped, never auto-started.
  const expiresAt = Number(value.expiresAt ?? value.validUntil);
  if (Number.isFinite(expiresAt) && expiresAt > 0 && now >= expiresAt)
    return false;

  for (const key of ['owner', 'hasOwner', 'owned', 'present', 'active', 'available']) {
    if (Object.prototype.hasOwnProperty.call(value, key))
      return Boolean(value[key]);
  }
  return true;
}

function ownerFor(owners, busName, now) {
  if (owners === undefined || owners === null || busName === '')
    return false;

  if (typeof owners === 'function') {
    try {
      return Boolean(owners(busName, now));
    } catch {
      return false;
    }
  }

  if (owners instanceof Map ||
      (typeof owners.get === 'function' && typeof owners.has === 'function')) {
    if (typeof owners.has === 'function' && !owners.has(busName))
      return false;
    return ownerValue(owners.get(busName), now);
  }

  if (typeof owners.has === 'function')
    return Boolean(owners.has(busName));

  if (Array.isArray(owners)) {
    for (const entry of owners) {
      if (typeof entry === 'string') {
        if (entry === busName)
          return true;
        continue;
      }
      if (entry && typeof entry === 'object' &&
          providerBusName(entry) === busName)
        return ownerValue(entry, now);
    }
    return false;
  }

  if (typeof owners === 'object') {
    if (!Object.prototype.hasOwnProperty.call(owners, busName))
      return false;
    return ownerValue(owners[busName], now);
  }

  return false;
}

function isCoolingDown(provider, now) {
  if (!provider || typeof provider !== 'object')
    return false;
  const until = Number(provider.blockedUntil ?? provider.cooldownUntil ?? 0);
  return Number.isFinite(until) && until > now;
}

/**
 * Choose the native providers that may be queried for one search.
 *
 * A provider is eligible only when its `BusName` has an owner. `AutoStart=true`
 * in its .ini deliberately has no influence: an ownerless provider is skipped,
 * never queried and never auto-started. Results preserve the input order so the
 * caller keeps discovery order; the optional `limit` caps the number of
 * providers (not the number of results) queried in one pass.
 *
 * Supported `owners` shapes: a Set of bus names, an Array of bus names or
 * `{busName, owner}` records, a Map/plain object `busName -> boolean|record`,
 * or a `(busName, now) => boolean` predicate. Owner records may carry an
 * `expiresAt` timestamp (checked against `now`). Provider records may carry a
 * `blockedUntil`/`cooldownUntil` timestamp to keep a recently failed provider
 * out of the next attempt.
 *
 * @param {{owners?: Set<string>|string[]|Map<string, *>|object|Function,
 *   providers?: Array<string|object>, limit?: number, now?: number}} [options]
 * @returns {Array<string|object>} eligible providers in query order
 */
export function selectRemoteCandidates(options = {}) {
  const source = options && typeof options === 'object' ? options : {};
  const now = Number.isFinite(Number(source.now)) ? Number(source.now) : Date.now();
  const limit = normalizeLimit(source.limit, DEFAULT_LIMIT);
  if (limit === 0)
    return [];

  const providers = asArray(source.providers);

  const selected = [];
  for (const provider of providers) {
    if (selected.length >= limit)
      break;

    const busName = providerBusName(provider);
    if (busName === '' || !ownerFor(source.owners, busName, now))
      continue;
    if (isCoolingDown(provider, now))
      continue;

    selected.push(provider);
  }
  return selected;
}

function resultBusName(result) {
  if (!result || typeof result !== 'object')
    return '';
  const explicit = String(
    result.busName ??
    result.remote?.busName ??
    result.activation?.busName ??
    ''
  ).trim();
  if (explicit !== '')
    return explicit;

  // Results produced by remote.js use `<BusName>:<remoteId>` and always
  // carry the bus in the id. Recover it for callers that pass flat ids only.
  const id = String(result.id ?? '');
  const separator = id.indexOf(':');
  if (separator > 0) {
    const prefix = id.slice(0, separator);
    if (prefix.includes('.'))
      return prefix;
  }
  return '';
}

function resultRemoteId(result) {
  if (!result || typeof result !== 'object')
    return '';
  const explicit = result.remoteId ??
    result.remote?.remoteId ??
    result.activation?.remoteId;
  if (explicit !== undefined && explicit !== null)
    return String(explicit);

  const id = String(result.id ?? '');
  const busName = resultBusName(result);
  if (busName !== '' && id.startsWith(`${busName}:`))
    return id.slice(busName.length + 1);
  return id;
}

function resultKey(result) {
  return `${resultBusName(result)}\u0000${resultRemoteId(result)}`;
}

function resultScore(result) {
  const score = Number(result?.score);
  return Number.isFinite(score) ? score : 0;
}

/**
 * Sort, de-duplicate and cap native results for one query.
 *
 * Ordering is score descending, then title using Polish collation, then input
 * order. Duplicate `busName + remoteId` pairs are collapsed by keeping the
 * first (highest-scored) occurrence. The input array and its objects are not
 * mutated.
 *
 * @param {object[]} results
 * @param {number} [limit=3]
 * @returns {object[]}
 */
export function capRemoteResults(results, limit = DEFAULT_LIMIT) {
  if (!Array.isArray(results))
    return [];

  const max = normalizeLimit(limit, DEFAULT_LIMIT);
  if (max === 0)
    return [];

  const sorted = results.map((result, index) => ({ result, index }));
  sorted.sort((a, b) =>
    resultScore(b.result) - resultScore(a.result) ||
    String(a.result?.title ?? a.result?.name ?? '')
      .localeCompare(String(b.result?.title ?? b.result?.name ?? ''), 'pl') ||
    a.index - b.index
  );

  const seen = new Set();
  const capped = [];
  for (const entry of sorted) {
    const result = entry.result;
    if (!result || typeof result !== 'object')
      continue;
    if (resultBusName(result) === '' && resultRemoteId(result) === '')
      continue;

    const key = resultKey(result);
    if (seen.has(key))
      continue;
    seen.add(key);
    capped.push(result);
    if (capped.length >= max)
      break;
  }
  return capped;
}

export const REMOTE_RESULT_LIMIT = DEFAULT_LIMIT;
export default selectRemoteCandidates;