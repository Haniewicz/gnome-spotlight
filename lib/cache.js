// PURE module: no GI or shell-resource imports.
//
// Small TTL cache shared by providers. Entries are computed lazily and expire
// after `ttlMs`; `now` is injectable so the behaviour is deterministic in
// tests. Keeping this abstraction free of GI means it can be exercised by the
// plain gjs test runner.

const DEFAULT_TTL_MS = 0;

function toNow(now) {
  if (typeof now === 'function')
    return now;
  const fixed = Number(now);
  return () => fixed;
}

/**
 * Create a TTL cache.
 *
 * `get(key, compute)` returns the cached value while it is fresh. On a miss
 * (or after expiry) it calls `compute(key)` once and stores the result.
 * `invalidate()` drops every entry, `invalidate(key)` drops one entry, and
 * `clear()` drops entries plus statistics. `stats()` reports counters and the
 * current entry count.
 *
 * @param {{ttlMs?: number, now?: (() => number)|number, maxEntries?: number}} [options]
 * @returns {{
 *   get: (key: *, compute?: (key: *) => *) => *,
 *   has: (key: *) => boolean,
 *   invalidate: (key?: *) => void,
 *   clear: () => void,
 *   stats: () => object,
 * }}
 */
export function ttlCache(options = {}) {
  const ttlMs = Number(options.ttlMs);
  const ttl = Number.isFinite(ttlMs) && ttlMs >= 0 ? ttlMs : DEFAULT_TTL_MS;
  const maxEntries = Number(options.maxEntries);
  const limit = Number.isFinite(maxEntries) && maxEntries > 0
    ? Math.floor(maxEntries)
    : Infinity;
  const now = toNow(options.now ?? Date.now);

  const entries = new Map();
  let hits = 0;
  let misses = 0;
  let invalidations = 0;
  let evictions = 0;
  let expired = 0;

  function readNow() {
    const value = Number(now());
    return Number.isFinite(value) ? value : 0;
  }

  function get(key, compute) {
    const at = readNow();
    const entry = entries.get(key);

    if (entry) {
      if (at < entry.expiresAt) {
        hits++;
        return entry.value;
      }
      entries.delete(key);
      expired++;
    }

    misses++;
    if (typeof compute !== 'function')
      return undefined;

    const value = compute(key);
    const storedAt = readNow();
    entries.delete(key);
    entries.set(key, { value, expiresAt: storedAt + ttl });

    if (entries.size > limit) {
      const oldest = entries.keys().next();
      if (!oldest.done) {
        entries.delete(oldest.value);
        evictions++;
      }
    }

    return value;
  }

  function has(key) {
    const at = readNow();
    const entry = entries.get(key);
    if (!entry)
      return false;
    if (at >= entry.expiresAt) {
      entries.delete(key);
      expired++;
      return false;
    }
    return true;
  }

  function invalidate(key) {
    invalidations++;
    if (arguments.length > 0)
      entries.delete(key);
    else
      entries.clear();
  }

  function clear() {
    entries.clear();
    hits = 0;
    misses = 0;
    invalidations = 0;
    evictions = 0;
    expired = 0;
  }

  function stats() {
    return {
      size: entries.size,
      hits,
      misses,
      invalidations,
      evictions,
      expired,
    };
  }

  return { get, has, invalidate, clear, stats };
}

export default ttlCache;
