// PURE module: no GI or shell-resource imports.
//
// Small, dependency-free path index used by gnome-spotlightd as a supplement
// to Tracker/localsearch. Tracker deliberately ignores the contents of git
// repositories, so project files such as docs/DESIGN.md never reach the
// launcher through the system index. This module only stores paths and a
// little stat metadata; it never touches the filesystem itself.
import { fold } from './text.js';

export const DEFAULT_MAX_ENTRIES = 200000;
export const MAX_FILE_SIZE = 5 * 1024 * 1024;
export const EXCLUDED_SEGMENTS = Object.freeze([
  '.git',
  'node_modules',
  '.venv',
  'dist',
  'build',
  '.cache',
]);

const EXCLUDED = new Set(EXCLUDED_SEGMENTS);
const DEFAULT_SEARCH_LIMIT = Infinity;

function normalizeMaxEntries(value, fallback = DEFAULT_MAX_ENTRIES) {
  if (value === undefined || value === null)
    return fallback;
  const number = Number(value);
  if (!Number.isFinite(number))
    return fallback;
  return Math.max(0, Math.floor(number));
}

function normalizeLimit(value) {
  if (value === undefined || value === null)
    return DEFAULT_SEARCH_LIMIT;
  const number = Number(value);
  // Infinity is the documented default: it means "return every match", not
  // "no limit is invalid". Only NaN and negative limits collapse to zero.
  if (number === Infinity)
    return Infinity;
  if (!Number.isFinite(number) || number < 0)
    return 0;
  return Math.floor(number);
}

function normalizePath(value) {
  let path = String(value ?? '').trim();
  if (path === '')
    return '';
  // Collapse repeated separators but keep the filesystem root intact.
  path = path.replace(/\/+/g, '/');
  if (path.length > 1)
    path = path.replace(/\/+$/, '');
  return path;
}

function basenameOf(path) {
  if (path === '/')
    return '/';
  const index = path.lastIndexOf('/');
  return index >= 0 ? path.slice(index + 1) : path;
}

function isExcludedPath(path) {
  for (const segment of String(path).split('/')) {
    if (segment !== '' && EXCLUDED.has(segment.toLowerCase()))
      return true;
  }
  return false;
}

function normalizeSize(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0)
    return null;
  return Math.floor(number);
}

function normalizeModified(value) {
  if (value === null || value === undefined || value === '')
    return null;
  const number = Number(value);
  if (Number.isFinite(number))
    return Math.floor(number);
  return String(value);
}

function metadataObject(metadata) {
  if (metadata === null || metadata === undefined)
    return {};
  if (typeof metadata === 'number')
    return { size: metadata };
  if (typeof metadata === 'object' && !Array.isArray(metadata))
    return metadata;
  return {};
}

function isDirectoryMetadata(metadata) {
  return metadata.isDirectory === true ||
    metadata.isDir === true ||
    metadata.directory === true ||
    metadata.type === 'directory' ||
    metadata.type === 'dir' ||
    metadata.kind === 'directory';
}

function makeEntry(path, metadata = {}) {
  const name = basenameOf(path);
  const segments = path.split('/').filter(Boolean);
  return {
    path,
    name,
    foldedName: fold(name),
    foldedSegments: segments.map(segment => fold(segment)),
    segments,
    isDirectory: isDirectoryMetadata(metadata),
    size: normalizeSize(metadata.size),
    modified: normalizeModified(
      metadata.modified ?? metadata.mtime ?? metadata.timeModified
    ),
  };
}

function matchWeight(entry, needle) {
  if (needle === '')
    return 0;

  const name = entry.foldedName;
  // A basename prefix is the strongest signal. Exact equality is handled by
  // the same bucket and wins the tie-break below through its shorter name.
  if (name.startsWith(needle))
    return 3;
  if (name.includes(needle))
    return 2;

  // Directory segments count, but only at the lowest weight.
  for (let index = 0; index < entry.foldedSegments.length - 1; index++) {
    const segment = entry.foldedSegments[index];
    if (segment.startsWith(needle) || segment.includes(needle))
      return 1;
  }

  return 0;
}

function resultFor(entry, score) {
  return {
    id: entry.path,
    path: entry.path,
    name: entry.name,
    basename: entry.name,
    key: `${entry.name} ${entry.path}`,
    score,
    weight: score,
    isDirectory: entry.isDirectory,
    isDir: entry.isDirectory,
    size: entry.size,
    modified: entry.modified,
  };
}

function compareMatches(a, b) {
  if (b.score !== a.score)
    return b.score - a.score;
  if (b.exact !== a.exact)
    return b.exact - a.exact;
  // "DESIGN" is a whole-name prefix of "DESIGN.md" but only a partial prefix
  // of "design-reference.png"; the former must win even though both score 3.
  if (b.wholeNamePrefix !== a.wholeNamePrefix)
    return b.wholeNamePrefix - a.wholeNamePrefix;
  if (a.entry.foldedName.length !== b.entry.foldedName.length)
    return a.entry.foldedName.length - b.entry.foldedName.length;
  if (a.entry.segments.length !== b.entry.segments.length)
    return a.entry.segments.length - b.entry.segments.length;
  if (a.entry.path.length !== b.entry.path.length)
    return a.entry.path.length - b.entry.path.length;
  return a.entry.path.localeCompare(b.entry.path, 'pl');
}

/**
 * In-memory path index.
 *
 * `add()` accepts either a path string plus optional stat metadata
 * (`{size, modified, isDirectory}`) or a single object carrying `path`.
 * Excluded directories (`.git`, `node_modules`, ...) and files larger than
 * 5 MB are ignored. The entry count is capped; `prune()` removes the oldest
 * entries first so the index always stays within its configured bound.
 */
export class PathIndex {
  /**
   * @param {number|{maxEntries?: number, max?: number, limit?: number}} [options]
   */
  constructor(options = {}) {
    let config = options;
    if (typeof options === 'number')
      config = { maxEntries: options };
    if (!config || typeof config !== 'object' || Array.isArray(config))
      config = {};

    const maxEntries = normalizeMaxEntries(
      config.maxEntries ?? config.max ?? config.limit,
      DEFAULT_MAX_ENTRIES
    );

    this.maxEntries = maxEntries;
    this.limit = maxEntries;
    this._entries = new Map();
  }

  /** @returns {number} number of indexed paths */
  get size() {
    return this._entries.size;
  }

  /**
   * Add or refresh one path.
   *
   * @param {string|object} path
   * @param {object|number} [metadata]
   * @returns {boolean} true when the path is indexed
   */
  add(path, metadata = {}) {
    let rawPath = path;
    let info = metadata;

    if (path && typeof path === 'object') {
      info = path;
      rawPath = path.path ?? path.file ?? path.value ?? '';
    }
    info = metadataObject(info);

    const normalized = normalizePath(rawPath);
    if (normalized === '' || isExcludedPath(normalized))
      return false;

    const entry = makeEntry(normalized, info);
    if (!entry.isDirectory &&
        entry.size !== null &&
        entry.size > MAX_FILE_SIZE)
      return false;

    if (this.maxEntries <= 0)
      return false;

    if (!this._entries.has(normalized) &&
        this._entries.size >= this.maxEntries)
      this.prune(this.maxEntries - 1);

    // Map#set keeps the original insertion position for updates, which makes
    // pruning deterministic: the least recently discovered path goes first.
    this._entries.set(normalized, entry);

    if (this._entries.size > this.maxEntries)
      this.prune(this.maxEntries);

    return true;
  }

  /**
   * Remove one path.
   *
   * @param {string} path
   * @returns {boolean}
   */
  remove(path) {
    const normalized = normalizePath(path);
    if (normalized === '')
      return false;
    return this._entries.delete(normalized);
  }

  /** @param {string} path */
  has(path) {
    const normalized = normalizePath(path);
    return normalized !== '' && this._entries.has(normalized);
  }

  /** Remove every entry. */
  clear() {
    this._entries.clear();
  }

  /**
   * Return copies of the indexed metadata in insertion order.
   *
   * @returns {object[]}
   */
  entries() {
    return [...this._entries.values()].map(entry => ({
      path: entry.path,
      name: entry.name,
      size: entry.size,
      modified: entry.modified,
      isDirectory: entry.isDirectory,
    }));
  }

  /**
   * Search the index.
   *
   * Weights: basename prefix = 3, basename contains = 2, any other path
   * segment = 1. Multiple whitespace-separated terms must all match; their
   * weights are added. Ties prefer an exact basename, then a whole-name prefix
   * ("DESIGN" before "design-reference.png"), then the shorter basename, the
   * shallower path, the shorter path and finally the Polish collation order so
   * results are deterministic across runs.
   *
   * @param {string} query
   * @param {number} [limit]
   * @returns {object[]}
   */
  search(query, limit = DEFAULT_SEARCH_LIMIT) {
    const max = normalizeLimit(limit);
    if (max <= 0)
      return [];

    const foldedQuery = fold(query).trim();
    if (foldedQuery === '')
      return [];

    const terms = foldedQuery.split(/\s+/).filter(Boolean);
    const matches = [];
    // Keep the working set bounded for launcher-sized limits (8-64). Without
    // this, a one-letter query over a 200k-entry index would allocate and sort
    // hundreds of thousands of match objects on every keystroke.
    const keep = Number.isFinite(max) ? Math.max(max * 4, 64) : Infinity;

    for (const entry of this._entries.values()) {
      let score = 0;
      let matched = true;
      for (const term of terms) {
        const weight = matchWeight(entry, term);
        if (weight === 0) {
          matched = false;
          break;
        }
        score += weight;
      }
      if (!matched)
        continue;

      const singleTerm = terms.length === 1 ? terms[0] : '';
      matches.push({
        entry,
        score,
        exact: singleTerm !== '' && entry.foldedName === singleTerm ? 1 : 0,
        wholeNamePrefix: singleTerm !== '' &&
          entry.foldedName.startsWith(`${singleTerm}.`) ? 1 : 0,
      });

      if (matches.length >= keep) {
        matches.sort(compareMatches);
        matches.length = max;
      }
    }

    matches.sort(compareMatches);
    return matches
      .slice(0, max)
      .map(match => resultFor(match.entry, match.score));
  }

  /**
   * Drop the oldest entries until at most `maxEntries` remain.
   *
   * @param {number} [maxEntries]
   * @returns {number} number of removed entries
   */
  prune(maxEntries = this.maxEntries) {
    const target = normalizeMaxEntries(maxEntries, this.maxEntries);
    if (this._entries.size <= target)
      return 0;

    let removed = 0;
    for (const key of this._entries.keys()) {
      if (this._entries.size <= target)
        break;
      this._entries.delete(key);
      removed++;
    }
    return removed;
  }

  /**
   * Serialize to JSON. Only paths and minimal stat metadata are persisted.
   *
   * @returns {string}
   */
  serialize() {
    const entries = [...this._entries.values()].map(entry => ({
      path: entry.path,
      size: entry.size,
      modified: entry.modified,
      isDirectory: entry.isDirectory,
    }));
    return JSON.stringify({
      version: 1,
      maxEntries: this.maxEntries,
      entries,
    });
  }

  /**
   * Parse a serialized index. Invalid or truncated JSON yields an empty,
   * usable index instead of throwing.
   *
   * @param {*} json
   * @returns {PathIndex}
   */
  static parse(json) {
    let raw = json;
    if (typeof raw === 'string') {
      if (raw.trim() === '')
        return new PathIndex();
      try {
        raw = JSON.parse(raw);
      } catch {
        return new PathIndex();
      }
    }

    if (!raw || typeof raw !== 'object')
      return new PathIndex();

    const maxEntries = normalizeMaxEntries(
      raw.maxEntries ?? raw.max ?? raw.limit,
      DEFAULT_MAX_ENTRIES
    );
    const index = new PathIndex({ maxEntries });
    const entries = Array.isArray(raw)
      ? raw
      : (Array.isArray(raw.entries) ? raw.entries : []);

    for (const item of entries) {
      if (typeof item === 'string') {
        index.add(item);
      } else if (item && typeof item === 'object' && item.path) {
        index.add(item.path, item);
      }
    }
    return index;
  }
}

export default PathIndex;