// Daemon-side file provider backed by `locate`. The parser is shared with the
// Shell provider through the PURE lib/files-parse.js module.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import { shortenPath } from '../../lib/format.js';
import { parseLocateOutput } from '../../lib/files-parse.js';
import { scoreResult } from '../../lib/ranking.js';
import { ProviderPriority } from '../../lib/providers/registry.js';

const PROVIDER_ID = 'files';
const LOCATE_TIMEOUT_MS = 300;
const DEFAULT_LIMIT = 20;
const SUBTITLE_LENGTH = 64;

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

export function pathToResult(path, homeDir = homeDirectory(), subtitleLength = SUBTITLE_LENGTH) {
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
    path: value,
    activation: { type: 'file', path: value },
    actions: {
      primary: {
        id: 'open',
        label: 'Otwórz',
        type: 'file',
        path: value,
      },
      secondary: {
        id: 'copy-path',
        label: 'Kopiuj ścieżkę',
        type: 'copy',
        text: value,
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
        ['Typ', kind],
        ['Katalog', parentDirectory(value)],
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

export function createProvider(options = {}) {
  return {
    id: PROVIDER_ID,
    title: 'Pliki',
    priority: ProviderPriority.NORMAL,
    prefix: 'f ',
    // Slightly above the locate budget so the provider can degrade to an
    // empty list itself instead of being cut off by the registry race.
    timeoutMs: 350,
    dispose() {},
    async search(query, context = {}) {
      const needle = String(query ?? '').trim();
      if (needle === '' || scoreResult(needle, { title: needle, key: needle }) <= 0)
        return [];

      const limit = resolveLimit(options, context);
      const paths = await spawnLocate(needle, limit);
      const homeDir = homeDirectory();
      return paths.map(path => pathToResult(path, homeDir));
    },
  };
}

export default createProvider;