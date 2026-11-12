// PURE module: no GI or shell-resource imports.
//
// Clipboard history kept by the Shell process. The store is deliberately
// independent of GSettings/Gio so it can be exercised by `gjs -m` without a
// GNOME Shell session. Persistence and the actual St.Clipboard access live in
// lib/providers/clipboard.js.

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TTL_MS = 7 * DAY_MS;
const DEFAULT_LIMIT = 100;
const DEFAULT_MAX_BYTES = 65536;
const DEFAULT_MIME = 'text/plain';

function toPositiveInteger(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0)
    return fallback;
  return Math.floor(number);
}

function normalizeTimestamp(value, fallback) {
  if (value === null || value === undefined || value === '')
    return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0)
    return fallback;
  return Math.floor(number);
}

/**
 * UTF-8 byte length without relying on TextEncoder (gjs versions differ).
 *
 * @param {string} text
 * @returns {number}
 */
function utf8Length(text) {
  let bytes = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff &&
               index + 1 < text.length &&
               text.charCodeAt(index + 1) >= 0xdc00 &&
               text.charCodeAt(index + 1) <= 0xdfff) {
      bytes += 4;
      index++;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

/**
 * Stable content hash: FNV-1a over UTF-16 code units, rendered as 8 lowercase
 * hex characters. The id only depends on the text, never on the timestamp or
 * the insertion order.
 *
 * @param {string} text
 * @returns {string}
 */
function hashText(text) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function cloneEntry(entry) {
  return {
    id: entry.id,
    text: entry.text,
    mime: entry.mime,
    count: entry.count,
    lastUsed: entry.lastUsed,
  };
}

function normalizeEntry(raw, nowMs, maxBytes) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    return null;

  const text = typeof raw.text === 'string' ? raw.text : '';
  if (text === '' || utf8Length(text) > maxBytes)
    return null;

  const count = toPositiveInteger(raw.count, 1);
  const lastUsed = normalizeTimestamp(raw.lastUsed, nowMs);
  const mime = typeof raw.mime === 'string' && raw.mime !== ''
    ? raw.mime
    : DEFAULT_MIME;

  return {
    id: hashText(text),
    text,
    mime,
    count,
    lastUsed,
  };
}

/**
 * Bounded, deduplicated clipboard history.
 *
 * Entries are ordered by `lastUsed` descending. Re-adding the same text moves
 * the existing entry to the front and increments its `count` instead of
 * creating a duplicate.
 */
export class ClipboardStore {
  /**
   * @param {object} [options]
   * @param {() => number} [options.now] injectable clock (epoch ms)
   * @param {number} [options.limit] maximum number of entries (default 100)
   * @param {number} [options.maxBytes] maximum size of one entry (default 64 KiB)
   * @param {number} [options.ttlMs] entry TTL from lastUsed (default 7 days)
   */
  constructor(options = {}) {
    const settings = options && typeof options === 'object' ? options : {};
    this._now = typeof settings.now === 'function' ? settings.now : Date.now;
    this._limit = toPositiveInteger(settings.limit, DEFAULT_LIMIT);
    this._maxBytes = toPositiveInteger(settings.maxBytes, DEFAULT_MAX_BYTES);
    this._ttlMs = toPositiveInteger(settings.ttlMs, DEFAULT_TTL_MS);
    this._entries = [];
  }

  /** @returns {() => number} */
  get now() {
    return this._now;
  }

  /** @returns {number} */
  get limit() {
    return this._limit;
  }

  /** @returns {number} */
  get maxBytes() {
    return this._maxBytes;
  }

  /** @returns {number} */
  get size() {
    this._prune();
    return this._entries.length;
  }

  _timestamp() {
    try {
      const value = Number(this._now());
      return Number.isFinite(value) ? Math.floor(value) : Date.now();
    } catch {
      return Date.now();
    }
  }

  _prune() {
    const nowMs = this._timestamp();
    this._entries = this._entries.filter(entry =>
      nowMs - entry.lastUsed < this._ttlMs
    );

    if (this._entries.length > this._limit)
      this._entries = this._entries.slice(0, this._limit);
  }

  /**
   * Add one clipboard entry.
   *
   * @param {{text?: string, mime?: string}} input
   * @returns {object|null} stored entry copy, or null when skipped
   */
  add(input) {
    if (!input || typeof input !== 'object')
      return null;

    const text = typeof input.text === 'string' ? input.text : '';
    if (text === '')
      return null;
    if (utf8Length(text) > this._maxBytes)
      return null;

    const nowMs = this._timestamp();
    const mime = typeof input.mime === 'string' && input.mime !== ''
      ? input.mime
      : DEFAULT_MIME;

    // Drop entries that already outlived their TTL before deduplicating, so
    // copying the same text after a week starts a fresh counter.
    this._prune();

    const existing = this._entries.find(entry => entry.text === text);
    if (existing) {
      existing.count += 1;
      existing.lastUsed = nowMs;
      existing.mime = mime;
      this._entries = this._entries.filter(entry => entry !== existing);
      this._entries.unshift(existing);
      this._prune();
      return cloneEntry(existing);
    }

    const entry = {
      id: hashText(text),
      text,
      mime,
      count: 1,
      lastUsed: nowMs,
    };
    this._entries.unshift(entry);
    this._prune();
    return cloneEntry(entry);
  }

  /**
   * Entries sorted by lastUsed descending, newest first.
   *
   * @returns {object[]} copies, safe for callers to mutate
   */
  list() {
    this._prune();
    return this._entries.map(cloneEntry);
  }

  /**
   * @param {string|{id?: string}} id
   * @returns {boolean} true when an entry was removed
   */
  remove(id) {
    const key = id && typeof id === 'object' ? id.id : id;
    if (typeof key !== 'string' || key === '')
      return false;

    const before = this._entries.length;
    this._entries = this._entries.filter(entry => entry.id !== key);
    return this._entries.length !== before;
  }

  /** Drop every entry. */
  clear() {
    this._entries = [];
  }

  /**
   * @returns {string} JSON with a version wrapper, stable across restarts
   */
  serialize() {
    this._prune();
    return JSON.stringify({
      version: 1,
      entries: this._entries.map(cloneEntry),
    });
  }

  /**
   * Build a store from serialized JSON. Invalid input (empty string, broken
   * JSON, null, arrays, primitives) yields an empty store instead of throwing.
   *
   * @param {*} json
   * @param {object} [options] same options as the constructor
   * @returns {ClipboardStore}
   */
  static parse(json, options = {}) {
    const store = new ClipboardStore(options);
    const fallbackNow = store._timestamp();

    let raw = json;
    if (typeof raw === 'string') {
      if (raw.trim() === '')
        return store;
      try {
        raw = JSON.parse(raw);
      } catch {
        return store;
      }
    }

    if (!raw || typeof raw !== 'object')
      return store;

    let entries = null;
    if (Array.isArray(raw)) {
      entries = raw;
    } else if (raw.entries !== undefined) {
      entries = raw.entries;
    } else if (raw.items !== undefined) {
      entries = raw.items;
    }

    if (!Array.isArray(entries))
      return store;

    const byText = new Map();
    for (const candidate of entries) {
      const entry = normalizeEntry(candidate, fallbackNow, store._maxBytes);
      if (!entry)
        continue;

      const previous = byText.get(entry.text);
      if (previous) {
        previous.count += entry.count;
        previous.lastUsed = Math.max(previous.lastUsed, entry.lastUsed);
        if (entry.mime)
          previous.mime = entry.mime;
        continue;
      }
      byText.set(entry.text, entry);
    }

    store._entries = [...byText.values()].sort(
      (a, b) => b.lastUsed - a.lastUsed
    );
    store._prune();
    return store;
  }
}

export { utf8Length, hashText };
export default ClipboardStore;