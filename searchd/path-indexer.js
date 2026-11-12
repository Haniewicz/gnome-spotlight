// Daemon-side path indexer.
//
// Tracker/localsearch intentionally ignores the contents of git repositories
// (its content filter rejects the parent directory), so project documentation
// under ~/Projects never reaches the launcher. This indexer walks the roots
// from GSettings asynchronously and keeps a small on-disk snapshot in
// $XDG_CACHE_HOME/gnome-spotlight/pathindex.json.
//
// Design constraints:
// - no synchronous enumerate_children over a tree, only *_async variants,
// - at most BATCH_SIZE entries per main-loop turn,
// - a hard 20 s budget per root,
// - indexing starts on the first `files` query, never during daemon startup,
// - Gio.FileMonitor watches the roots and directories below them, never all of
//   $HOME.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {
  DEFAULT_MAX_ENTRIES,
  EXCLUDED_SEGMENTS,
  PathIndex,
} from '../lib/path-index.js';

export const CACHE_SUBDIR = 'gnome-spotlight';
export const CACHE_NAME = 'pathindex.json';
export const BATCH_SIZE = 500;
export const ROOT_TIMEOUT_MS = 20000;
export const SAVE_DEBOUNCE_MS = 5000;
export const MAX_MONITORS = 4096;
export const PROGRESS_STEP = 5000;

export const DEFAULT_EXTRA_INDEX_ROOTS = Object.freeze([
  '$HOME/Projects',
  '$HOME/Dokumenty',
]);
export const DEFAULT_ROOTS = DEFAULT_EXTRA_INDEX_ROOTS;
const OPTIONAL_DEFAULT_ROOTS = Object.freeze(['$HOME/Projekty']);
const ATTRS = 'standard::name,standard::type,standard::size,time::modified';
const EXCLUDED = new Set(EXCLUDED_SEGMENTS.map(segment => segment.toLowerCase()));

function positiveInteger(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0)
    return fallback;
  return Math.floor(number);
}

function nonNegativeInteger(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0)
    return fallback;
  return Math.floor(number);
}

function decodeUtf8(contents) {
  if (typeof contents === 'string')
    return contents;
  if (!contents)
    return '';
  try {
    return new TextDecoder('utf-8').decode(contents);
  } catch {
    let output = '';
    for (const byte of contents)
      output += String.fromCharCode(byte);
    return output;
  }
}

function encodeUtf8(text) {
  try {
    return new TextEncoder().encode(text);
  } catch {
    const bytes = [];
    for (let index = 0; index < text.length; index++)
      bytes.push(text.charCodeAt(index) & 0xff);
    return new Uint8Array(bytes);
  }
}

export function defaultCachePath() {
  try {
    return GLib.build_filenamev([
      GLib.get_user_cache_dir(),
      CACHE_SUBDIR,
      CACHE_NAME,
    ]);
  } catch {
    return null;
  }
}

function homeDirectory() {
  try {
    return String(GLib.get_home_dir() ?? '');
  } catch {
    return '';
  }
}

export function expandHome(value, home) {
  let path = String(value ?? '').trim();
  if (path === '')
    return '';

  if (path === '$HOME' || path === '${HOME}' || path === '~')
    path = home;
  else if (path.startsWith('$HOME/'))
    path = GLib.build_filenamev([home, path.slice('$HOME/'.length)]);
  else if (path.startsWith('${HOME}/'))
    path = GLib.build_filenamev([home, path.slice('${HOME}/'.length)]);
  else if (path.startsWith('~/'))
    path = GLib.build_filenamev([home, path.slice(2)]);

  // Paths that still contain an unexpanded variable are not safe to scan.
  if (path.includes('$'))
    return '';
  return path;
}

function sameRoots(values, expected) {
  if (!Array.isArray(values) || values.length !== expected.length)
    return false;
  return values.every((value, index) => String(value) === expected[index]);
}

function readConfiguredRoots(settings) {
  if (!settings)
    return null;
  try {
    const roots = settings.get_strv('extra-index-roots');
    if (Array.isArray(roots))
      return roots.map(value => String(value));
  } catch {
    // Missing schema or an old extension install: use the defaults.
  }
  return null;
}

function readConfiguredMaxEntries(settings) {
  if (!settings)
    return DEFAULT_MAX_ENTRIES;
  try {
    return nonNegativeInteger(
      settings.get_int('path-index-max-entries'),
      DEFAULT_MAX_ENTRIES
    );
  } catch {
    return DEFAULT_MAX_ENTRIES;
  }
}

export function resolveRoots(settings, explicitRoots, home) {
  const explicit = Array.isArray(explicitRoots);
  const configured = explicit
    ? explicitRoots.map(value => String(value))
    : readConfiguredRoots(settings);
  // An explicit list (including []) always wins. An empty GSettings list is a
  // deliberate "index nothing" choice; only a missing schema/key falls back to
  // the built-in defaults.
  const usingDefaults = !explicit &&
    (configured === null || sameRoots(configured, DEFAULT_EXTRA_INDEX_ROOTS));

  const source = explicit
    ? configured
    : (configured ?? DEFAULT_EXTRA_INDEX_ROOTS);

  const roots = [];
  const seen = new Set();
  const add = value => {
    const expanded = expandHome(value, home);
    if (expanded === '' || seen.has(expanded))
      return;
    seen.add(expanded);
    roots.push(expanded);
  };

  for (const value of source)
    add(value);

  // The old P2 card mentions ~/Projekty as an optional code root. Keep the
  // schema default unchanged (Projects + Dokumenty) but use the directory when
  // it exists and the user has not customised the list.
  if (usingDefaults) {
    for (const value of OPTIONAL_DEFAULT_ROOTS) {
      const expanded = expandHome(value, home);
      if (expanded !== '' &&
          !seen.has(expanded) &&
          GLib.file_test(expanded, GLib.FileTest.IS_DIR))
        add(expanded);
    }
  }

  return roots;
}

function fileType(info) {
  try {
    return info.get_file_type();
  } catch {
    return Gio.FileType.UNKNOWN;
  }
}

function modifiedOf(info) {
  try {
    const seconds = info.get_attribute_uint64('time::modified');
    return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
  } catch {
    return null;
  }
}

/**
 * Asynchronous owner of a PathIndex.
 *
 * `search()` is intentionally cheap: it only reads the in-memory map. The
 * first call starts the scan in the background; `searchAsync()` may wait for a
 * small bounded slice so the very first launcher query can already see part of
 * the fresh index without exceeding the first-query budget.
 */
export class PathIndexer {
  /**
   * @param {object} [options]
   * @param {object|null} [options.settings] Gio.Settings-like object
   * @param {string[]} [options.roots] explicit roots (tests / one-off daemon)
   * @param {number} [options.maxEntries]
   * @param {string} [options.cachePath]
   * @param {string} [options.home]
   * @param {PathIndex} [options.index]
   * @param {boolean} [options.loadCache]
   */
  constructor(options = {}) {
    const config = options && typeof options === 'object' ? options : {};
    this._home = config.home ?? homeDirectory();
    this._settings = config.settings ?? null;
    this._cachePath = config.cachePath !== undefined
      ? config.cachePath
      : defaultCachePath();
    this._batchSize = positiveInteger(config.batchSize, BATCH_SIZE);
    this._rootTimeoutMs = positiveInteger(config.rootTimeoutMs, ROOT_TIMEOUT_MS);
    this._debounceMs = positiveInteger(config.debounceMs, SAVE_DEBOUNCE_MS);
    this._maxMonitors = positiveInteger(config.maxMonitors, MAX_MONITORS);

    const maxEntries = config.maxEntries !== undefined
      ? nonNegativeInteger(config.maxEntries, DEFAULT_MAX_ENTRIES)
      : readConfiguredMaxEntries(this._settings);
    this._index = config.index instanceof PathIndex
      ? config.index
      : new PathIndex({ maxEntries });
    this._roots = resolveRoots(
      this._settings,
      config.roots,
      this._home
    );

    this._started = false;
    this._building = false;
    this._disposed = false;
    this._loadedFromCache = false;
    this._queue = [];
    this._queued = new Set();
    this._current = null;
    this._idleId = 0;
    this._saveTimerId = 0;
    this._dirty = false;
    this._waitTimers = new Set();
    this._lastProgress = 0;
    this._timedOutRoots = new Set();
    this._cancellable = new Gio.Cancellable();
    this._monitors = new Map();
    this._monitored = new Set();
    this._stats = {
      entries: this._index.size,
      roots: this._roots.slice(),
      building: false,
      loadedFromCache: false,
      scanned: 0,
      startedAt: 0,
      finishedAt: 0,
      timedOutRoots: [],
    };

    if (config.loadCache !== false)
      this.loadCache();
  }

  get index() {
    return this._index;
  }

  get size() {
    return this._index.size;
  }

  get roots() {
    return this._roots.slice();
  }

  get cachePath() {
    return this._cachePath;
  }

  get isBuilding() {
    return this._building;
  }

  get hasLoadedCache() {
    return this._loadedFromCache;
  }

  /**
   * Cheap value that changes whenever a cached answer may be stale. The files
   * provider includes it in its cache key: during the first scan the index is
   * growing, and once the scan finishes even an unchanged size becomes a new
   * revision.
   */
  get revision() {
    return `${this._index.size}:${this._building ? 1 : 0}:${this._stats.finishedAt}`;
  }

  getStats() {
    return {
      ...this._stats,
      entries: this._index.size,
      roots: this._roots.slice(),
      building: this._building,
      loadedFromCache: this._loadedFromCache,
      timedOutRoots: [...this._timedOutRoots],
    };
  }

  /**
   * Read the cached snapshot synchronously. This happens once at daemon start
   * (the file is small compared with a Tracker query) and never on a keystroke.
   *
   * @returns {boolean}
   */
  loadCache() {
    if (!this._cachePath)
      return false;
    try {
      const [ok, contents] = GLib.file_get_contents(this._cachePath);
      if (!ok)
        return false;
      const text = decodeUtf8(contents);
      if (text.trim() === '')
        return false;
      const cached = PathIndex.parse(text);
      for (const entry of cached.entries())
        this._index.add(entry.path, entry);
      this._loadedFromCache = true;
      this._stats.loadedFromCache = true;
      this._stats.entries = this._index.size;
      return true;
    } catch {
      return false;
    }
  }

  /** Start the asynchronous scan. Safe to call more than once. */
  start() {
    if (this._started || this._disposed)
      return this;
    this._started = true;
    this._building = true;
    this._stats.building = true;
    this._stats.startedAt = Date.now();

    if (this._roots.length === 0) {
      this._finishBuild();
      return this;
    }

    for (const root of this._roots) {
      let isDirectory = false;
      try {
        isDirectory = GLib.file_test(root, GLib.FileTest.IS_DIR);
      } catch {
        isDirectory = false;
      }
      if (!isDirectory) {
        this._log(`path index: pomijam brakujący korzeń ${root}`);
        continue;
      }
      this._monitorDirectory(root, root);
      this._enqueueDirectory(root, root, Date.now());
      this._log(`path index: skanuję ${root}`);
    }

    if (this._queue.length === 0)
      this._finishBuild();
    else
      this._scheduleStep();
    return this;
  }

  /** Alias used by the files provider before the first query. */
  ensureStarted() {
    return this.start();
  }

  /**
   * Search the already indexed paths. Starts the background scan when needed.
   *
   * @param {string} query
   * @param {number} [limit]
   * @returns {object[]}
   */
  search(query, limit = Infinity) {
    this.ensureStarted();
    return this._index.search(query, limit);
  }

  /**
   * Search, optionally giving a fresh scan a small head start. The wait is
   * bounded by the caller (the files provider uses 120 ms for the first
   * query), so the 20 s root budget never leaks into a keystroke. A small
   * index that finishes sooner returns immediately.
   *
   * @param {string} query
   * @param {number} [limit]
   * @param {number} [waitMs]
   * @returns {Promise<object[]>}
   */
  async searchAsync(query, limit = Infinity, waitMs = 0) {
    this.ensureStarted();
    const wait = Number(waitMs);
    if (this._building && Number.isFinite(wait) && wait > 0) {
      const deadline = Date.now() + Math.floor(wait);
      while (this._building && !this._disposed) {
        const remaining = deadline - Date.now();
        if (remaining <= 0)
          break;
        await this._sleep(Math.min(25, remaining));
      }
    }
    return this._index.search(query, limit);
  }

  /** Persist the current snapshot immediately (testing/shutdown). */
  saveNow() {
    if (!this._cachePath)
      return false;
    try {
      GLib.mkdir_with_parents(GLib.path_get_dirname(this._cachePath), 0o700);
      const bytes = encodeUtf8(this._index.serialize());
      GLib.file_set_contents(this._cachePath, bytes);
      this._dirty = false;
      return true;
    } catch {
      return false;
    }
  }

  dispose() {
    if (this._disposed)
      return;
    this._disposed = true;

    if (this._idleId) {
      try {
        GLib.source_remove(this._idleId);
      } catch {
        // Already fired.
      }
      this._idleId = 0;
    }
    if (this._saveTimerId) {
      try {
        GLib.source_remove(this._saveTimerId);
      } catch {
        // Already fired.
      }
      this._saveTimerId = 0;
    }
    for (const timerId of this._waitTimers) {
      try {
        GLib.source_remove(timerId);
      } catch {
        // Already fired.
      }
    }
    this._waitTimers.clear();

    try {
      this._cancellable.cancel();
    } catch {
      // Cancellation is best effort.
    }

    this._closeEnumerator();
    for (const { monitor } of this._monitors.values()) {
      try {
        monitor.cancel();
      } catch {
        // Monitor already cancelled.
      }
    }
    this._monitors.clear();
    this._monitored.clear();
    this._queue = [];
    this._queued.clear();

    // Flush the final snapshot so a daemon restart does not lose the scan.
    if (this._dirty)
      this.saveNow();
    this._building = false;
  }

  _log(message) {
    try {
      printerr(`gnome-spotlightd: ${message}`);
    } catch {
      // Logging must never break the indexer.
    }
  }

  _sleep(ms) {
    return new Promise(resolve => {
      if (this._disposed) {
        resolve();
        return;
      }
      const timerId = GLib.timeout_add(
        GLib.PRIORITY_DEFAULT,
        Math.max(1, Math.floor(ms)),
        () => {
          this._waitTimers.delete(timerId);
          resolve();
          return GLib.SOURCE_REMOVE;
        }
      );
      this._waitTimers.add(timerId);
    });
  }

  _isExcluded(name) {
    return EXCLUDED.has(String(name).toLowerCase());
  }

  _insideRoots(path) {
    const value = String(path ?? '');
    return this._roots.some(root =>
      value === root || value.startsWith(`${root}/`)
    );
  }

  _enqueueDirectory(path, root, startedAt) {
    if (this._disposed || this._queued.has(path))
      return;
    this._queued.add(path);
    this._queue.push({ path, root, rootStartedAt: startedAt });
    if (!this._building) {
      this._building = true;
      this._stats.building = true;
    }
    this._scheduleStep();
  }

  _scheduleStep() {
    if (this._disposed || this._idleId)
      return;
    this._idleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
      this._idleId = 0;
      if (this._disposed)
        return GLib.SOURCE_REMOVE;
      if (this._current)
        this._readBatch();
      else
        this._pump();
      return GLib.SOURCE_REMOVE;
    });
  }

  _expireRoot(root) {
    if (this._timedOutRoots.has(root))
      return;
    this._timedOutRoots.add(root);
    this._log(`path index: limit ${this._rootTimeoutMs} ms dla ${root}`);
  }

  _dropRoot(root) {
    if (this._current && this._current.root === root) {
      this._closeEnumerator();
      this._current = null;
    }
    this._queue = this._queue.filter(item => {
      if (item.root !== root)
        return true;
      this._queued.delete(item.path);
      return false;
    });
  }

  _pump() {
    if (this._disposed)
      return;

    while (this._queue.length > 0) {
      const item = this._queue[0];
      if (Date.now() - item.rootStartedAt > this._rootTimeoutMs) {
        this._queue.shift();
        this._queued.delete(item.path);
        this._expireRoot(item.root);
        this._dropRoot(item.root);
        continue;
      }
      break;
    }

    if (this._queue.length === 0) {
      this._finishBuild();
      return;
    }

    const item = this._queue.shift();
    this._queued.delete(item.path);
    let file;
    try {
      file = Gio.File.new_for_path(item.path);
    } catch {
      this._scheduleStep();
      return;
    }

    // Asynchronous enumeration is the whole point: a large tree must never
    // stall the daemon's main loop.
    file.enumerate_children_async(
      ATTRS,
      Gio.FileQueryInfoFlags.NONE,
      GLib.PRIORITY_DEFAULT_IDLE,
      this._cancellable,
      (source, result) => {
        if (this._disposed)
          return;
        let enumerator = null;
        try {
          enumerator = source.enumerate_children_finish(result);
        } catch (error) {
          if (!this._cancellable.is_cancelled())
            this._log(`path index: nie mogę czytać ${item.path}: ${error.message}`);
          this._scheduleStep();
          return;
        }
        if (!enumerator) {
          this._scheduleStep();
          return;
        }
        this._current = {
          ...item,
          enumerator,
        };
        this._scheduleStep();
      }
    );
  }

  _readBatch() {
    if (this._disposed || !this._current)
      return;

    const current = this._current;
    if (Date.now() - current.rootStartedAt > this._rootTimeoutMs) {
      this._expireRoot(current.root);
      this._dropRoot(current.root);
      this._scheduleStep();
      return;
    }

    current.enumerator.next_files_async(
      this._batchSize,
      GLib.PRIORITY_DEFAULT_IDLE,
      this._cancellable,
      (source, result) => {
        if (this._disposed)
          return;

        let infos = [];
        try {
          infos = source.next_files_finish(result) ?? [];
        } catch (error) {
          if (!this._cancellable.is_cancelled())
            this._log(`path index: błąd enumeracji ${current.path}: ${error.message}`);
          infos = [];
        }

        if (infos.length === 0) {
          this._closeEnumerator();
          this._current = null;
          this._scheduleStep();
          return;
        }

        for (const info of infos) {
          this._stats.scanned++;
          let name = '';
          try {
            name = String(info.get_name() ?? '');
          } catch {
            name = '';
          }
          if (name === '' || this._isExcluded(name))
            continue;

          const path = GLib.build_filenamev([current.path, name]);
          const type = fileType(info);
          const modified = modifiedOf(info);

          if (type === Gio.FileType.DIRECTORY) {
            this._index.add(path, { isDirectory: true, modified });
            this._monitorDirectory(path, current.root);
            this._enqueueDirectory(path, current.root, current.rootStartedAt);
          } else if (type === Gio.FileType.REGULAR) {
            let size = null;
            try {
              size = info.get_size();
            } catch {
              size = null;
            }
            this._index.add(path, { size, modified });
          }
        }

        this._markDirty();
        this._progress();
        // Exactly one batch per main-loop turn; next_files_async itself is
        // scheduled on the idle priority.
        this._scheduleStep();
      }
    );
  }

  _closeEnumerator() {
    if (!this._current)
      return;
    try {
      this._current.enumerator.close(null);
    } catch {
      // Enumeration may already be finished/cancelled.
    }
    this._current = null;
  }

  _progress() {
    const bucket = Math.floor(this._index.size / PROGRESS_STEP);
    if (bucket === this._lastProgress)
      return;
    this._lastProgress = bucket;
    this._log(`path index: ${this._index.size} wpisów`);
  }

  _finishBuild() {
    if (!this._building)
      return;
    this._building = false;
    this._stats.building = false;
    this._stats.entries = this._index.size;
    this._stats.finishedAt = Date.now();
    const elapsed = Math.max(0, this._stats.finishedAt - this._stats.startedAt);
    this._log(
      `path index: gotowy, ${this._index.size} wpisów, ` +
      `${this._stats.scanned} odwiedzonych, ${elapsed} ms`
    );
    this._markDirty();
  }

  _markDirty() {
    this._dirty = true;
    if (this._saveTimerId || this._disposed)
      return;
    this._saveTimerId = GLib.timeout_add(
      GLib.PRIORITY_DEFAULT,
      this._debounceMs,
      () => {
        this._saveTimerId = 0;
        this._saveAsync();
        return GLib.SOURCE_REMOVE;
      }
    );
  }

  _saveAsync() {
    if (!this._cachePath || this._disposed)
      return;
    const json = this._index.serialize();
    const revision = this.revision;
    try {
      GLib.mkdir_with_parents(GLib.path_get_dirname(this._cachePath), 0o700);
      const file = Gio.File.new_for_path(this._cachePath);
      const bytes = new GLib.Bytes(encodeUtf8(json));
      file.replace_contents_bytes_async(
        bytes,
        null,
        false,
        Gio.FileCreateFlags.REPLACE_DESTINATION,
        this._cancellable,
        (target, result) => {
          try {
            target.replace_contents_bytes_finish(result);
            if (this.revision === revision)
              this._dirty = false;
          } catch {
            // Cache writes are best effort; the launcher must keep working.
          }
        }
      );
    } catch {
      // A read-only or full cache directory is not fatal.
    }
  }

  _monitorDirectory(path, root) {
    if (this._disposed ||
        this._monitored.has(path) ||
        this._monitors.size >= this._maxMonitors)
      return;
    try {
      const file = Gio.File.new_for_path(path);
      const monitor = file.monitor_directory(Gio.FileMonitorFlags.NONE, null);
      monitor.connect('changed', (_monitor, changed, otherFile, eventType) => {
        this._onChanged(changed, otherFile, eventType, root);
      });
      this._monitors.set(path, { monitor, root });
      this._monitored.add(path);
    } catch {
      // Some roots are not monitorable (permissions, virtual filesystems).
    }
  }

  _removeTree(path) {
    const prefix = `${path}/`;
    let removed = false;
    for (const entry of this._index.entries()) {
      if (entry.path === path || entry.path.startsWith(prefix))
        removed = this._index.remove(entry.path) || removed;
    }
    return removed;
  }

  _onChanged(changed, otherFile, eventType, root) {
    if (this._disposed)
      return;

    let path = '';
    try {
      path = String(changed?.get_path?.() ?? '');
    } catch {
      path = '';
    }
    if (path === '' || !this._insideRoots(path))
      return;

    const event = Number(eventType);
    const deleted = event === Gio.FileMonitorEvent.DELETED ||
      event === Gio.FileMonitorEvent.MOVED_OUT ||
      event === Gio.FileMonitorEvent.VOID;

    if (deleted) {
      if (this._removeTree(path))
        this._markDirty();
      return;
    }

    this._refreshPath(path, root);
    if (event === Gio.FileMonitorEvent.MOVED ||
        event === Gio.FileMonitorEvent.RENAMED) {
      let otherPath = '';
      try {
        otherPath = String(otherFile?.get_path?.() ?? '');
      } catch {
        otherPath = '';
      }
      if (otherPath !== '' && otherPath !== path && this._insideRoots(otherPath))
        this._refreshPath(otherPath, root);
    }
  }

  _refreshPath(path, root) {
    let file;
    try {
      file = Gio.File.new_for_path(path);
    } catch {
      return;
    }

    file.query_info_async(
      ATTRS,
      Gio.FileQueryInfoFlags.NONE,
      GLib.PRIORITY_DEFAULT_IDLE,
      this._cancellable,
      (source, result) => {
        if (this._disposed)
          return;
        let info = null;
        try {
          info = source.query_info_finish(result);
        } catch {
          if (this._removeTree(path))
            this._markDirty();
          return;
        }
        if (!info)
          return;

        let name = path;
        try {
          name = String(info.get_name() ?? path);
        } catch {
          name = path;
        }
        if (this._isExcluded(name))
          return;

        const type = fileType(info);
        const modified = modifiedOf(info);
        if (type === Gio.FileType.DIRECTORY) {
          this._index.add(path, { isDirectory: true, modified });
          if (path === root)
            this._monitorDirectory(path, root);
          else
            this._monitorDirectory(path, root);
          this._enqueueDirectory(path, root, Date.now());
        } else if (type === Gio.FileType.REGULAR) {
          let size = null;
          try {
            size = info.get_size();
          } catch {
            size = null;
          }
          this._index.add(path, { size, modified });
        } else {
          return;
        }

        this._markDirty();
        this._progress();
      }
    );
  }
}

/**
 * @param {object} [options]
 * @returns {PathIndexer}
 */
export function createPathIndexer(options = {}) {
  return new PathIndexer(options);
}

export default PathIndexer;