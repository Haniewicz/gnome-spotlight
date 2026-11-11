import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import { shortenPath } from '../format.js';
import { scoreResult } from '../ranking.js';
import { ProviderPriority } from './registry.js';

const PROVIDER_ID = 'files';
const LOCATE_TIMEOUT_MS = 300;
const DEFAULT_LIMIT = 20;
const SUBTITLE_LENGTH = 64;

const JUNK_SEGMENTS = new Set(['.git', 'node_modules', '.cache']);
const JUNK_ROOTS = ['/proc', '/sys', '/dev'];

function isJunkPath(path) {
  const value = String(path);

  for (const root of JUNK_ROOTS) {
    if (value === root || value.startsWith(`${root}/`))
      return true;
  }

  if (value.includes('/.local/share/Trash/') ||
      value.endsWith('/.local/share/Trash'))
    return true;

  for (const segment of value.split('/')) {
    if (JUNK_SEGMENTS.has(segment))
      return true;
  }

  return false;
}

function normalizeLimit(limit) {
  if (limit === undefined || limit === null)
    return Infinity;
  const value = Number(limit);
  if (!Number.isFinite(value) || value < 0)
    return 0;
  return Math.floor(value);
}

/**
 * Turn raw `locate` stdout into a filtered, de-duplicated list of paths.
 * This is pure so the provider can be tested without spawning a process.
 *
 * @param {*} stdout
 * @param {number} [limit]
 * @returns {string[]}
 */
export function parseLocateOutput(stdout, limit = Infinity) {
  if (typeof stdout !== 'string')
    return [];

  const max = normalizeLimit(limit);
  if (max <= 0)
    return [];

  const seen = new Set();
  const paths = [];

  for (const rawLine of stdout.split(/\r?\n/)) {
    const path = rawLine.trim();
    if (path === '' || seen.has(path) || isJunkPath(path))
      continue;

    seen.add(path);
    paths.push(path);
    if (paths.length >= max)
      break;
  }

  return paths;
}

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

/**
 * Convert one path into a SearchResult. Exported for tests; the provider uses
 * the same function with the real home directory.
 *
 * @param {string} path
 * @param {string} [homeDir]
 * @param {number} [subtitleLength]
 * @returns {object}
 */
export function pathToResult(path, homeDir = GLib.get_home_dir(), subtitleLength = SUBTITLE_LENGTH) {
  const value = String(path);
  const name = basename(value);
  const kind = extensionOf(value);
  const subtitle = shortenPath(value, homeDir, subtitleLength);

  return {
    id: value,
    providerId: PROVIDER_ID,
    title: name || value,
    subtitle,
    kind,
    icon: 'text-x-generic-symbolic',
    key: `${name} ${value}`,
    usageKey: `files:${value}`,
    actions: {
      primary: () => {
        try {
          const uri = GLib.filename_to_uri(value, null);
          Gio.AppInfo.launch_default_for_uri(uri, null);
        } catch {
          // A missing default handler must not throw out of the launcher.
        }
      },
    },
    preview: {
      rows: [
        ['Ścieżka', value],
        ['Typ', kind],
      ],
      description: value,
    },
  };
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

function spawnLocate(query, limit) {
  return new Promise(resolve => {
    let executable = null;
    try {
      executable = GLib.find_program_in_path('locate');
    } catch {
      executable = null;
    }

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
        // The process may have exited between the check and the call.
      }
      // Never wait for locate longer than the budget; an empty result is the
      // documented degradation when the index is slow or missing.
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

/**
 * File provider backed by `locate`. No index is ever built here and a missing
 * binary simply yields an empty section.
 */
export function createProvider(options = {}) {
  return {
    id: PROVIDER_ID,
    title: 'Pliki',
    priority: ProviderPriority.NORMAL,
    prefix: null,
    // Slightly above the 300 ms subprocess budget so the provider can return
    // an empty list instead of being killed by the registry race.
    timeoutMs: 350,
    async search(query, context = {}) {
      const needle = String(query ?? '').trim();
      if (needle === '' || scoreResult(needle, { title: needle, key: needle }) <= 0)
        return [];

      const limit = resolveLimit(options, context);
      const paths = await spawnLocate(needle, limit);
      const homeDir = (() => {
        try {
          return GLib.get_home_dir();
        } catch {
          return '';
        }
      })();

      return paths.map(path => pathToResult(path, homeDir));
    },
  };
}

export default createProvider;