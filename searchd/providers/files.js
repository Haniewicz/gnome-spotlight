// Daemon-side file provider. Tracker/localsearch is the primary source, with
// `locate` kept as a fallback for systems without the local index. The parser
// shared with the Shell provider lives in the PURE lib/files-parse.js module.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import { shortenPath } from '../../lib/format.js';
import { parseLocateOutput } from '../../lib/files-parse.js';
import { scorePathMatch, scoreResult } from '../../lib/ranking.js';
import { fold } from '../../lib/text.js';
import { ProviderPriority } from '../../lib/providers/registry.js';
import {
  buildSearchQuery,
  mapRow,
  sanitizeTerm,
} from '../../lib/tracker-query.js';
import { createPathIndexer } from '../path-indexer.js';

const PROVIDER_ID = 'files';
const DEFAULT_LIMIT = 8;
const TRACKER_LIMIT = 8;
// Tracker's own FTS ordering is not the launcher's ordering: a query such as
// "DESIGN" returns many emulated Windows DLLs before a project's DESIGN.md.
// Fetch a wider candidate window, score it with the shared path ranking and
// only then apply the public limit below.
const TRACKER_CANDIDATE_LIMIT = 64;
// The own path index is a supplement, not a replacement. Fetch a slightly
// wider window than the public limit, merge it with Tracker by path and let
// the shared ranking decide which rows survive.
const PATH_CANDIDATE_LIMIT = 64;
// The first `files` query may spend a little longer while the in-memory path
// index is still being filled. 120 ms keeps it inside the extension's 150 ms
// daemon budget as well as the explicitly allowed 300 ms first-query budget.
const PATH_FIRST_WAIT_MS = 120;
const PATH_WEIGHT_BONUS = 50;
const TRACKER_TIMEOUT_MS = 120;
// The registry races each provider independently. The files provider's first
// query is allowed 300 ms; later queries finish with the cached path index
// immediately and stay well below the 30 ms benchmark threshold.
const FILES_PROVIDER_TIMEOUT_MS = 300;
const TRACKER_CACHE_TTL_MS = 5 * 1000;
const TRACKER_CACHE_MAX = 32;
const TRACKER_BUS_NAME = 'org.freedesktop.Tracker3.Miner.Files';
const LOCATE_TIMEOUT_MS = 300;
const SUBTITLE_LENGTH = 64;

const SOURCE_AUTO = 'auto';
const SOURCE_TRACKER = 'tracker';
const SOURCE_LOCATE = 'locate';
const SOURCES = new Set([SOURCE_AUTO, SOURCE_TRACKER, SOURCE_LOCATE]);

const MIME_ICONS = {
  image: 'image-x-generic-symbolic',
  audio: 'audio-x-generic-symbolic',
  video: 'video-x-generic-symbolic',
  text: 'text-x-generic-symbolic',
  font: 'font-x-generic-symbolic',
};

function basename(path) {
  const value = String(path);
  const trimmed = value.endsWith('/') && value.length > 1
    ? value.slice(0, -1)
    : value;
  const index = trimmed.lastIndexOf('/');
  return index >= 0 ? trimmed.slice(index + 1) : trimmed;
}

function extensionOf(path) {
  const name = basename(path);
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1)
    return 'Plik';
  return name.slice(dot + 1).toLowerCase();
}

function parentDirectory(path) {
  const value = String(path);
  const index = value.lastIndexOf('/');
  if (index <= 0)
    return '/';
  return value.slice(0, index);
}

function resolveLimit(options, context) {
  const candidates = [
    context?.limit,
    context?.maxResults,
    typeof options.getLimit === 'function' ? options.getLimit() : options.limit,
  ];
  for (const candidate of candidates) {
    const value = Number(candidate);
    if (Number.isFinite(value) && value > 0)
      return Math.floor(value);
  }
  return DEFAULT_LIMIT;
}

function homeDirectory() {
  try {
    return GLib.get_home_dir();
  } catch {
    return '';
  }
}

function guessMime(path) {
  try {
    const [contentType] = Gio.content_type_guess(String(path), null);
    return String(contentType ?? '');
  } catch {
    return '';
  }
}

function mimeGroup(mime) {
  const value = String(mime ?? '');
  const slash = value.indexOf('/');
  if (slash <= 0)
    return '';
  return value.slice(0, slash).toLowerCase();
}

function iconFor(mime) {
  const group = mimeGroup(mime);
  return MIME_ICONS[group] ?? 'text-x-generic-symbolic';
}

/**
 * Convert a file path into the result shape consumed by the daemon.
 *
 * @param {string} path
 * @param {string} [homeDir]
 * @param {number} [subtitleLength]
 * @param {{name?: string, mime?: string, size?: number|null,
 *   modified?: (string|number|null), score?: number}} [metadata]
 * @returns {object}
 */
export function pathToResult(
  path,
  homeDir = homeDirectory(),
  subtitleLength = SUBTITLE_LENGTH,
  metadata = {}
) {
  const value = String(path);
  const info = metadata && typeof metadata === 'object' ? metadata : {};
  const name = String(info.name || basename(value) || value);
  const mime = String(info.mime || guessMime(value));
  const directory = info.isDirectory === true || info.isDir === true;
  const kind = directory ? 'Katalog' : (mimeGroup(mime) || extensionOf(value));
  const shortened = shortenPath(value, homeDir, subtitleLength);
  const subtitle = mime ? `${shortened} · ${mime}` : shortened;
  const size = Number.isFinite(Number(info.size)) ? Number(info.size) : null;
  const modified = info.modified ?? null;

  return {
    id: value,
    providerId: PROVIDER_ID,
    title: name,
    subtitle,
    kind,
    icon: directory ? 'folder-symbolic' : iconFor(mime),
    key: `${name} ${value}`,
    path: value,
    score: Number.isFinite(Number(info.score)) ? Number(info.score) : 0,
    activation: { type: 'file', path: value },
    actions: {
      primary: {
        id: 'open',
        label: 'Otwórz',
        type: 'file',
        path: value,
      },
      secondary: {
        id: 'reveal',
        label: 'Pokaż w plikach',
        type: 'reveal',
        path: value,
      },
      menu: [
        {
          id: 'open',
          label: 'Otwórz',
          type: 'file',
          path: value,
        },
        {
          id: 'reveal',
          label: 'Pokaż w plikach',
          type: 'reveal',
          path: value,
        },
        {
          id: 'copy-path',
          label: 'Kopiuj ścieżkę',
          type: 'copy',
          text: value,
        },
      ],
    },
    preview: {
      path: value,
      rows: [
        ['Ścieżka', value],
        ['Typ', mime || kind],
        ['Katalog', parentDirectory(value)],
        ...(size === null ? [] : [['Rozmiar', String(size)]]),
        ...(modified === null ? [] : [['Zmodyfikowano', String(modified)]]),
      ],
      description: value,
    },
  };
}

function findLocate() {
  try {
    return GLib.find_program_in_path('locate');
  } catch {
    return null;
  }
}

function spawnLocate(query, limit) {
  return new Promise(resolve => {
    const executable = findLocate();
    if (!executable || limit <= 0) {
      resolve([]);
      return;
    }

    let process = null;
    try {
      process = new Gio.Subprocess({
        argv: [executable, '-i', '-l', String(limit), '--', query],
        flags: Gio.SubprocessFlags.STDOUT_PIPE |
          Gio.SubprocessFlags.STDERR_SILENCE,
      });
      process.init(null);
    } catch {
      resolve([]);
      return;
    }

    let settled = false;
    let timerId = 0;

    const finish = stdout => {
      if (settled)
        return;
      settled = true;

      if (timerId) {
        try {
          GLib.source_remove(timerId);
        } catch {
          // The timer already fired.
        }
        timerId = 0;
      }

      resolve(parseLocateOutput(stdout, limit));
    };

    timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, LOCATE_TIMEOUT_MS, () => {
      timerId = 0;
      try {
        process.force_exit();
      } catch {
        // It may have exited between the check and the call.
      }
      finish('');
      return GLib.SOURCE_REMOVE;
    });

    try {
      process.communicate_utf8_async(null, null, (proc, result) => {
        let stdout = '';
        try {
          const [, output] = proc.communicate_utf8_finish(result);
          stdout = output ?? '';
        } catch {
          stdout = '';
        }
        finish(stdout);
      });
    } catch {
      finish('');
    }
  });
}

function normalizeSource(value) {
  const source = String(value ?? '').trim().toLowerCase();
  return SOURCES.has(source) ? source : SOURCE_AUTO;
}

function loadTrackerNamespace() {
  try {
    if (typeof imports === 'undefined')
      return null;
    return imports.gi?.Tracker ?? null;
  } catch {
    return null;
  }
}

function cursorValue(cursor, index) {
  try {
    const value = cursor.get_string(index);
    return Array.isArray(value) ? value[0] : value;
  } catch {
    try {
      return cursor.get_integer(index);
    } catch {
      return null;
    }
  }
}

function cursorRow(cursor) {
  const row = {};
  let columns = 0;
  try {
    columns = cursor.get_n_columns();
  } catch {
    columns = 0;
  }

  for (let index = 0; index < columns; index++) {
    let name = '';
    try {
      name = String(cursor.get_variable_name(index) ?? '');
    } catch {
      name = '';
    }
    const value = cursorValue(cursor, index);
    row[index] = value;
    if (name)
      row[name] = value;
  }

  return row;
}

/**
 * Execute a Tracker query asynchronously. A single GLib timeout cancels the
 * cancellable after `timeoutMs`, so the daemon main loop is never blocked by
 * a slow index lookup.
 *
 * @param {object} connection
 * @param {string} sparql
 * @param {number} limit
 * @param {number} timeoutMs
 * @returns {Promise<{rows: object[], timedOut: boolean, error: Error|null}>}
 */
function queryTracker(connection, sparql, limit, timeoutMs) {
  return new Promise(resolve => {
    let settled = false;
    let timerId = 0;
    let cursor = null;
    let statement = null;
    const rows = [];
    const seen = new Set();
    const cancellable = new Gio.Cancellable();

    const finish = (result) => {
      if (settled)
        return;
      settled = true;

      if (timerId) {
        try {
          GLib.source_remove(timerId);
        } catch {
          // The timer already fired.
        }
        timerId = 0;
      }

      try {
        cursor?.close();
      } catch {
        // The cursor may already be closed by cancellation.
      }
      cursor = null;

      resolve(result);
    };

    const fail = error => {
      finish({
        rows: [],
        timedOut: false,
        error: error ?? new Error('tracker query failed'),
      });
    };

    function next() {
      if (settled)
        return;
      if (rows.length >= limit) {
        finish({ rows, timedOut: false, error: null });
        return;
      }

      try {
        cursor.next_async(cancellable, (_source, result) => {
          if (settled)
            return;

          let hasNext = false;
          try {
            hasNext = cursor.next_finish(result);
          } catch (error) {
            fail(error);
            return;
          }

          if (!hasNext) {
            finish({ rows, timedOut: false, error: null });
            return;
          }

          try {
            const mapped = mapRow(cursorRow(cursor));
            if (mapped.path && !seen.has(mapped.path)) {
              seen.add(mapped.path);
              rows.push(mapped);
            }
          } catch (error) {
            fail(error);
            return;
          }

          next();
        });
      } catch (error) {
        fail(error);
      }
    }

    timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, timeoutMs, () => {
      timerId = 0;
      try {
        cancellable.cancel();
      } catch {
        // Cancellation is best effort.
      }
      finish({ rows: [], timedOut: true, error: null });
      return GLib.SOURCE_REMOVE;
    });

    try {
      statement = connection.query_statement(sparql, cancellable);
      statement.execute_async(cancellable, (_source, result) => {
        if (settled)
          return;
        try {
          cursor = statement.execute_finish(result);
        } catch (error) {
          fail(error);
          return;
        }
        next();
      });
    } catch (error) {
      fail(error);
    }
  });
}

export function createProvider(options = {}) {
  let trackerConnection = null;
  let trackerError = null;
  let pathIndexer = null;
  let pathIndexError = null;
  let ownsPathIndexer = false;
  let firstPathQuery = true;
  let stats = {
    filesSource: 'none',
    timedOut: false,
    filesMs: 0,
  };

  const cache = new Map();

  function ensurePathIndexer() {
    if (pathIndexer || pathIndexError)
      return pathIndexer;

    if (Object.prototype.hasOwnProperty.call(options, 'pathIndexer') &&
        (options.pathIndexer === false || options.pathIndexer === null))
      return null;

    if (options.pathIndexer &&
        (typeof options.pathIndexer.search === 'function' ||
         typeof options.pathIndexer.searchAsync === 'function')) {
      pathIndexer = options.pathIndexer;
      return pathIndexer;
    }

    try {
      pathIndexer = createPathIndexer({
        settings: options.settings ?? null,
        roots: options.indexRoots,
        maxEntries: options.maxEntries,
        cachePath: options.cachePath,
      });
      ownsPathIndexer = true;
    } catch (error) {
      pathIndexError = error;
      pathIndexer = null;
    }
    return pathIndexer;
  }

  function getSource() {
    let envSource = '';
    try {
      envSource = String(GLib.getenv('FILES_SOURCE') ?? '');
    } catch {
      envSource = '';
    }
    if (envSource.trim() !== '')
      return normalizeSource(envSource);

    let configured = options.filesSource ?? options.source;
    if (typeof configured === 'function')
      configured = configured();
    return normalizeSource(configured);
  }

  function setStats(source, timedOut, startedAt) {
    stats = {
      filesSource: source,
      timedOut: Boolean(timedOut),
      filesMs: Math.max(0, Date.now() - startedAt),
    };
  }

  function ensureTrackerConnection() {
    if (trackerConnection)
      return trackerConnection;

    const Tracker = loadTrackerNamespace();
    if (!Tracker) {
      trackerError = new Error('Tracker typelib is not available');
      return null;
    }

    try {
      trackerConnection = Tracker.SparqlConnection.bus_new(
        TRACKER_BUS_NAME,
        null,
        null
      );
      trackerError = null;
      return trackerConnection;
    } catch (error) {
      trackerError = error;
      trackerConnection = null;
      return null;
    }
  }

  function pathRevision() {
    if (!pathIndexer)
      return 'none';
    try {
      if (pathIndexer.revision !== undefined)
        return String(pathIndexer.revision);
      return `${pathIndexer.size}:${pathIndexer.isBuilding ? 1 : 0}`;
    } catch {
      return 'error';
    }
  }

  function cacheKey(source, needle, limit) {
    // The path index grows while it is built. Including its revision keeps a
    // tracker-only answer from the first warm-up query out of the way once the
    // project files have been indexed (and when the scan finishes).
    return `${source}\u0000${limit}\u0000${needle.toLowerCase()}\u0000` +
      pathRevision();
  }

  function cacheGet(key) {
    const entry = cache.get(key);
    if (!entry)
      return null;
    if (entry.expiresAt <= Date.now()) {
      cache.delete(key);
      return null;
    }
    return entry;
  }

  function cacheSet(key, rows, source) {
    if (cache.size >= TRACKER_CACHE_MAX) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined)
        cache.delete(oldest);
    }
    cache.set(key, {
      rows,
      source,
      expiresAt: Date.now() + TRACKER_CACHE_TTL_MS,
    });
  }

  function locateRows(paths) {
    return paths.map(path => ({
      path,
      name: basename(path),
      mime: '',
      size: null,
      modified: null,
      score: 0,
    }));
  }

  function resultRows(rows, needle, limit) {
    const home = homeDirectory();
    const foldedNeedle = fold(needle).trim();
    // Multi-term queries have no single "whole name" to compare against; this
    // mirrors the same condition in lib/path-index.js.
    const singleTerm = foldedNeedle !== '' && !foldedNeedle.includes(' ')
      ? foldedNeedle
      : '';

    const scored = rows.map(row => {
      const baseScore = Number(row.score);
      const pathWeight = Number(row.pathWeight);
      const path = String(row.path ?? '');
      const name = fold(String(row.name || basename(path)));
      return {
        row,
        path,
        name,
        score: (Number.isFinite(baseScore) ? baseScore : 0) +
          scorePathMatch(needle, { path: row.path, homeDir: home }) +
          (Number.isFinite(pathWeight) ? pathWeight * PATH_WEIGHT_BONUS : 0),
        exact: singleTerm !== '' && name === singleTerm ? 1 : 0,
        wholeNamePrefix: singleTerm !== '' &&
          name.startsWith(`${singleTerm}.`) ? 1 : 0,
        depth: path.split('/').filter(Boolean).length,
      };
    });

    // The provider must stay within the requested limit, but which rows
    // survive is decided by the path-aware score rather than Tracker order.
    // The tie-break matches lib/path-index.js: exact basename, whole-name
    // prefix, shorter name, shallower/shorter path, then Polish collation.
    scored.sort((a, b) => {
      if (b.score !== a.score)
        return b.score - a.score;
      if (b.exact !== a.exact)
        return b.exact - a.exact;
      if (b.wholeNamePrefix !== a.wholeNamePrefix)
        return b.wholeNamePrefix - a.wholeNamePrefix;
      if (a.name.length !== b.name.length)
        return a.name.length - b.name.length;
      if (a.depth !== b.depth)
        return a.depth - b.depth;
      if (a.path.length !== b.path.length)
        return a.path.length - b.path.length;
      return a.path.localeCompare(b.path, 'pl');
    });

    return scored
      .slice(0, Math.max(0, limit))
      .map(({ row, score }) =>
        pathToResult(row.path, home, SUBTITLE_LENGTH, {
          ...row,
          score,
        })
      );
  }

  async function searchTracker(needle, limit) {
    const connection = ensureTrackerConnection();
    if (!connection)
      return { rows: [], timedOut: false, error: trackerError };

    const candidates = Math.max(limit, TRACKER_CANDIDATE_LIMIT);
    const sparql = buildSearchQuery(needle, {
      limit: candidates,
      contentSearch: true,
    });
    return queryTracker(connection, sparql, candidates, TRACKER_TIMEOUT_MS);
  }

  function pathEntryRow(entry) {
    const path = String(entry?.path ?? '');
    if (path === '')
      return null;
    return {
      path,
      name: String(entry.name || basename(path)),
      mime: '',
      size: entry.size ?? null,
      modified: entry.modified ?? null,
      score: 0,
      pathWeight: Number(entry.score) || 0,
      isDirectory: entry.isDirectory === true || entry.isDir === true,
      fromPath: true,
    };
  }

  async function searchPath(needle, limit) {
    const indexer = ensurePathIndexer();
    if (!indexer)
      return { rows: [], available: false };

    const candidates = Math.max(limit, PATH_CANDIDATE_LIMIT);
    const waitMs = firstPathQuery ? PATH_FIRST_WAIT_MS : 0;
    firstPathQuery = false;

    try {
      const found = typeof indexer.searchAsync === 'function'
        ? await indexer.searchAsync(needle, candidates, waitMs)
        : await indexer.search(needle, candidates);
      const rows = (Array.isArray(found) ? found : [])
        .map(pathEntryRow)
        .filter(Boolean);
      return { rows, available: true };
    } catch (error) {
      pathIndexError = error;
      return { rows: [], available: false };
    }
  }

  function mergeRows(trackerRows, pathRows) {
    const byPath = new Map();

    for (const row of Array.isArray(trackerRows) ? trackerRows : []) {
      const path = String(row?.path ?? '');
      if (path === '')
        continue;
      byPath.set(path, { ...row, pathWeight: 0 });
    }

    for (const row of Array.isArray(pathRows) ? pathRows : []) {
      const path = String(row?.path ?? '');
      if (path === '')
        continue;
      const existing = byPath.get(path);
      if (existing) {
        existing.score = Math.max(
          Number(existing.score) || 0,
          Number(row.score) || 0
        );
        existing.pathWeight = Math.max(
          Number(existing.pathWeight) || 0,
          Number(row.pathWeight) || 0
        );
        existing.isDirectory = existing.isDirectory === true ||
          row.isDirectory === true;
        existing.fromPath = true;
        // The path index derives `name` from the real basename, so prefer it
        // for the shared tie-break instead of relying on Tracker's column.
        if (row.name)
          existing.name = String(row.name);
      } else {
        byPath.set(path, { ...row });
      }
    }

    return [...byPath.values()];
  }

  // Loading the cached snapshot is deliberate: it happens once when the
  // daemon starts, while the actual directory walk still waits for the first
  // `files` query.
  ensurePathIndexer();

  return {
    id: PROVIDER_ID,
    title: 'Pliki',
    priority: ProviderPriority.NORMAL,
    prefix: 'f ',
    // A fresh index gets one bounded head start (PATH_FIRST_WAIT_MS); after that
    // every query is in-memory and Tracker keeps its own 120 ms budget.
    timeoutMs: FILES_PROVIDER_TIMEOUT_MS,
    warmUp() {
      if (getSource() === SOURCE_LOCATE)
        return;

      const connection = ensureTrackerConnection();
      if (!connection)
        return;

      // Warm the FTS index before the daemon owns the bus name. This single
      // synchronous query runs only at startup, never on a keystroke.
      try {
        const sparql = buildSearchQuery('spotlightwarmup', {
          limit: 1,
          contentSearch: true,
        });
        const statement = connection.query_statement(sparql, null);
        const cursor = statement.execute(null);
        try {
          cursor.next(null);
        } finally {
          cursor.close();
        }
      } catch {
        // Warm-up is best effort; the first real query has its own budget.
      }
    },
    getStats() {
      return { ...stats };
    },
    dispose() {
      cache.clear();
      if (ownsPathIndexer) {
        try {
          pathIndexer?.dispose?.();
        } catch {
          // Path index shutdown is best effort.
        }
      }
      pathIndexer = null;
      const connection = trackerConnection;
      trackerConnection = null;
      if (!connection)
        return;
      try {
        connection.close();
      } catch {
        // Shutdown is best effort.
      }
    },
    async search(query, context = {}) {
      const startedAt = Date.now();
      const needle = sanitizeTerm(query);
      if (needle === '' || scoreResult(needle, { title: needle, key: needle }) <= 0)
        return [];

      const source = getSource();
      const limit = Math.min(resolveLimit(options, context), TRACKER_LIMIT);
      if (limit <= 0) {
        setStats(source === SOURCE_LOCATE ? SOURCE_LOCATE : 'none', false, startedAt);
        return [];
      }

      const usePath = source === SOURCE_AUTO;
      const pathBuilding = usePath && pathIndexer?.isBuilding === true;
      const key = cacheKey(source, needle, limit);
      const cached = pathBuilding ? null : cacheGet(key);
      if (cached) {
        setStats(cached.source, false, startedAt);
        return resultRows(cached.rows, needle, limit);
      }

      if (source === SOURCE_LOCATE) {
        const paths = await spawnLocate(needle, limit);
        const rows = locateRows(paths);
        setStats(SOURCE_LOCATE, false, startedAt);
        cacheSet(key, rows, SOURCE_LOCATE);
        return resultRows(rows, needle, limit);
      }

      // Tracker and the own path index are asked in parallel. The path index
      // is a supplement: it covers git repositories and other trees that
      // Tracker's content filter refuses to index.
      const pathPromise = usePath
        ? searchPath(needle, limit)
        : Promise.resolve({ rows: [], available: false });
      const [result, pathResult] = await Promise.all([
        searchTracker(needle, limit),
        pathPromise,
      ]);

      const trackerAnswered = !result.timedOut && !result.error;
      const pathAnswered = pathResult.available && pathResult.rows.length > 0;

      if (trackerAnswered) {
        const rows = mergeRows(result.rows, pathResult.rows);
        const filesSource = pathAnswered ? 'tracker+path' : SOURCE_TRACKER;
        setStats(filesSource, false, startedAt);
        cacheSet(key, rows, filesSource);
        return resultRows(rows, needle, limit);
      }

      if (pathAnswered) {
        setStats('path', Boolean(result.timedOut), startedAt);
        cacheSet(key, pathResult.rows, 'path');
        return resultRows(pathResult.rows, needle, limit);
      }

      if (result.timedOut) {
        setStats(SOURCE_TRACKER, true, startedAt);
        return [];
      }

      if (result.error) {
        if (source === SOURCE_TRACKER) {
          setStats('none', false, startedAt);
          return [];
        }

        // Auto mode falls back to `locate`; a missing mlocate database is an
        // empty list, not a user-visible error.
        const paths = await spawnLocate(needle, limit);
        const rows = locateRows(paths);
        setStats(SOURCE_LOCATE, false, startedAt);
        cacheSet(key, rows, SOURCE_LOCATE);
        return resultRows(rows, needle, limit);
      }

      setStats(SOURCE_TRACKER, false, startedAt);
      cacheSet(key, result.rows, SOURCE_TRACKER);
      return resultRows(result.rows, needle, limit);
    },
  };
}

export default createProvider;