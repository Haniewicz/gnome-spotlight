// PURE module: no GI or shell-resource imports.

const EMPTY_ENTRY = { count: 0, lastUsed: 0 };

function validEntry(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return null;

  const count = Number(value.count);
  const lastUsed = Number(value.lastUsed);

  return {
    count: Number.isFinite(count) && count > 0 ? Math.floor(count) : 0,
    lastUsed: Number.isFinite(lastUsed) && lastUsed > 0 ? Math.floor(lastUsed) : 0,
  };
}

function parseEntries(json) {
  if (typeof json !== 'string' || json.trim() === '')
    return {};

  let raw;
  try {
    raw = JSON.parse(json);
  } catch {
    return {};
  }

  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    return {};

  const entries = {};
  for (const [key, value] of Object.entries(raw)) {
    const entry = validEntry(value);
    if (key && entry)
      entries[key] = entry;
  }
  return entries;
}

/**
 * Persistent usage history for frecency ranking.
 *
 * The storage object is injectable and only needs `get(): string` and
 * `set(string)`, which is exactly the shape of a GSettings-backed wrapper.
 * Corrupted JSON or a broken storage object degrades to an empty state
 * instead of throwing.
 */
export class UsageStore {
  /**
   * @param {{get: Function, set: Function}|null} [storage]
   * @param {object} [entries] internal, used by parse()
   */
  constructor(storage = null, entries = null) {
    this._storage = storage;
    this._entries = entries ?? {};

    if (!entries && storage && typeof storage.get === 'function') {
      try {
        this._entries = parseEntries(storage.get());
      } catch {
        this._entries = {};
      }
    }
  }

  /**
   * Build a store from a JSON string. Invalid input (empty string, truncated
   * JSON, literal null, arrays, ...) yields an empty store without throwing.
   *
   * @param {*} json
   * @param {{get: Function, set: Function}|null} [storage]
   * @returns {UsageStore}
   */
  static parse(json, storage = null) {
    return new UsageStore(storage, parseEntries(json));
  }

  /**
   * Return a copy of the usage entry for a key. Missing keys report a
   * zeroed entry, which keeps scoring code branch-free.
   *
   * @param {string} key
   * @returns {{count: number, lastUsed: number}}
   */
  entry(key) {
    const value = this._entries[String(key)];
    if (!value)
      return { ...EMPTY_ENTRY };
    return { count: value.count, lastUsed: value.lastUsed };
  }

  /**
   * Record one use of a key.
   *
   * @param {string} key
   * @param {number} [nowMs]
   * @returns {{count: number, lastUsed: number}}
   */
  record(key, nowMs = Date.now()) {
    const normalizedKey = String(key ?? '');
    if (normalizedKey === '')
      return { ...EMPTY_ENTRY };

    const previous = this._entries[normalizedKey] ?? EMPTY_ENTRY;
    const timestamp = Number.isFinite(nowMs) ? Math.floor(nowMs) : Date.now();

    const entry = {
      count: previous.count + 1,
      lastUsed: timestamp,
    };
    this._entries[normalizedKey] = entry;
    this._persist();
    return { ...entry };
  }

  /**
   * @returns {string} JSON representation (empty state is "{}")
   */
  serialize() {
    return JSON.stringify(this._entries);
  }

  _persist() {
    if (!this._storage || typeof this._storage.set !== 'function')
      return;

    try {
      this._storage.set(this.serialize());
    } catch {
      // Persistence failures must not take the launcher down.
    }
  }
}