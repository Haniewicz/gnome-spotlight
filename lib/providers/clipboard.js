import GLib from 'gi://GLib';

import { ClipboardStore } from '../clipboard-store.js';
import { ProviderPriority } from './registry.js';

const PROVIDER_ID = 'clipboard';
const RESULT_LIMIT = 8;
const TITLE_MAX = 80;
const SAVE_DELAY_MS = 500;
const DEFAULT_MIME = 'text/plain';
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

let StModule = null;
let StPromise = null;

function loadSt() {
  if (StModule)
    return Promise.resolve(StModule);
  if (!StPromise) {
    StPromise = import('gi://St')
      .then(module => {
        StModule = module?.default ?? null;
        return StModule;
      })
      .catch(() => null);
  }
  return StPromise;
}

function defaultCachePath() {
  try {
    return GLib.build_filenamev([
      GLib.get_user_cache_dir(),
      'gnome-spotlight',
      'clipboard.json',
    ]);
  } catch {
    return null;
  }
}

function decodeUtf8(contents) {
  if (typeof contents === 'string')
    return contents;
  if (!contents)
    return '';

  try {
    return new TextDecoder('utf-8').decode(contents);
  } catch {
    // Fall through to the manual decoder below.
  }

  let output = '';
  for (const byte of contents)
    output += String.fromCharCode(byte);
  return output;
}

function encodeUtf8(text) {
  try {
    return new TextEncoder().encode(text);
  } catch {
    // Fall through to the manual encoder below.
  }

  const bytes = [];
  for (let index = 0; index < text.length; index++) {
    let code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff &&
        index + 1 < text.length &&
        text.charCodeAt(index + 1) >= 0xdc00 &&
        text.charCodeAt(index + 1) <= 0xdfff) {
      code = 0x10000 + ((code - 0xd800) << 10) +
        (text.charCodeAt(++index) - 0xdc00);
    }

    if (code < 0x80) {
      bytes.push(code);
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      bytes.push(
        0xe0 | (code >> 12),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f)
      );
    } else {
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f)
      );
    }
  }
  return new Uint8Array(bytes);
}

function readHistory(path) {
  if (!path)
    return '';
  try {
    const [ok, contents] = GLib.file_get_contents(path);
    return ok ? decodeUtf8(contents) : '';
  } catch {
    return '';
  }
}

function writeHistory(path, json) {
  if (!path)
    return;
  try {
    GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o700);
    GLib.file_set_contents(path, encodeUtf8(json));
  } catch {
    // Clipboard history persistence is best effort; the launcher must keep
    // working on a read-only or full cache directory.
  }
}

/**
 * GNOME Shell 51 exposes clipboard reads as an async callback:
 * `get_text(type, (clipboard, text) => …)`. Older St versions returned the
 * string directly, so both signatures are supported.
 *
 * @param {object} St
 * @returns {Promise<string>}
 */
function readClipboardText(St) {
  let clipboard;
  try {
    clipboard = St.Clipboard.get_default();
  } catch {
    return Promise.resolve('');
  }

  const type = St.ClipboardType.CLIPBOARD;
  if (!clipboard || typeof clipboard.get_text !== 'function')
    return Promise.resolve('');

  if (clipboard.get_text.length < 2) {
    try {
      const text = clipboard.get_text(type);
      return Promise.resolve(typeof text === 'string' ? text : '');
    } catch {
      return Promise.resolve('');
    }
  }

  return new Promise(resolve => {
    let settled = false;
    let timer = 0;

    const finish = (first, second) => {
      if (settled)
        return;
      settled = true;

      if (timer) {
        try {
          GLib.source_remove(timer);
        } catch {
          // The timer may already have fired.
        }
        timer = 0;
      }

      const text = typeof second === 'string'
        ? second
        : (typeof first === 'string' ? first : '');
      resolve(text);
    };

    timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
      timer = 0;
      finish('', '');
      return GLib.SOURCE_REMOVE;
    });

    try {
      clipboard.get_text(type, finish);
    } catch {
      finish('', '');
    }
  });
}

function firstLine(text) {
  const value = String(text ?? '');
  let line = value.split(/\r\n|\r|\n/, 1)[0].trim();
  if (line === '')
    line = value.trim();
  return line.length > TITLE_MAX
    ? `${line.slice(0, TITLE_MAX - 1)}…`
    : line;
}

function relativeTime(lastUsed, nowMs) {
  const age = Math.max(0, Number(nowMs) - Number(lastUsed));
  if (age < MINUTE_MS)
    return 'teraz';
  if (age < HOUR_MS)
    return `${Math.floor(age / MINUTE_MS)} min temu`;
  if (age < DAY_MS)
    return `${Math.floor(age / HOUR_MS)} h temu`;

  const days = Math.floor(age / DAY_MS);
  return `${days} ${days === 1 ? 'dzień' : 'dni'} temu`;
}

/**
 * Recognise both documented spellings: `cb ` and `clip…`.
 *
 * @param {*} raw
 * @returns {{active: boolean, needle: string}}
 */
export function parseClipboardQuery(raw) {
  const text = String(raw ?? '');
  const lower = text.toLowerCase();

  if (/^cb(?:\s|$)/.test(lower))
    return { active: true, needle: text.slice(2).trim() };

  if (lower.startsWith('clip')) {
    let rest = text.slice(4);
    if (rest.toLowerCase().startsWith('board'))
      rest = rest.slice(5);
    return { active: true, needle: rest.trim() };
  }

  return { active: false, needle: '' };
}

function normalizeLimit(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0)
    return fallback;
  return Math.min(RESULT_LIMIT, Math.floor(number));
}

/**
 * Shell-local clipboard provider.
 *
 * The provider never writes the clipboard on its own: capture only reads it
 * when the modal opens, and the clipboard write lives solely in the primary
 * action of a result. Persistence is a 500 ms debounced write to
 * `$XDG_CACHE_HOME/gnome-spotlight/clipboard.json`.
 */
export function createProvider(options = {}) {
  const settings = options && typeof options === 'object' ? options : {};
  const clock = typeof settings.now === 'function' ? settings.now : Date.now;
  const nowMs = () => {
    try {
      const value = Number(clock());
      return Number.isFinite(value) ? Math.floor(value) : Date.now();
    } catch {
      return Date.now();
    }
  };

  const cachePath = settings.cachePath === undefined
    ? defaultCachePath()
    : settings.cachePath;
  const clipboardAdapter = settings.clipboard ?? null;
  const store = settings.store ?? ClipboardStore.parse(
    readHistory(cachePath),
    {
      now: nowMs,
      limit: settings.storeLimit,
      maxBytes: settings.maxBytes,
    }
  );

  let saveTimer = 0;
  let capturePromise = null;
  let disposed = false;

  function cancelSave() {
    if (!saveTimer)
      return;
    try {
      GLib.source_remove(saveTimer);
    } catch {
      // The timer may already have fired.
    }
    saveTimer = 0;
  }

  function flush() {
    if (!cachePath || disposed)
      return;
    writeHistory(cachePath, store.serialize());
  }

  function scheduleSave() {
    if (!cachePath || disposed)
      return;

    // True debounce: each change pushes the write deadline 500 ms out.
    cancelSave();
    saveTimer = GLib.timeout_add(
      GLib.PRIORITY_DEFAULT,
      SAVE_DELAY_MS,
      () => {
        saveTimer = 0;
        flush();
        return GLib.SOURCE_REMOVE;
      }
    );
  }

  function remember(text) {
    if (typeof text !== 'string' || text === '')
      return;
    const entry = store.add({ text, mime: DEFAULT_MIME });
    if (entry)
      scheduleSave();
  }

  function resultFor(entry) {
    return {
      id: entry.id,
      providerId: PROVIDER_ID,
      title: firstLine(entry.text),
      subtitle: `schowek · ${relativeTime(entry.lastUsed, nowMs())} · ${entry.count}×`,
      kind: 'Schowek',
      icon: 'edit-copy-symbolic',
      key: entry.text,
      usageKey: `clipboard:${entry.id}`,
      actions: {
        primary: async () => {
          try {
            if (clipboardAdapter &&
                typeof clipboardAdapter.set_text === 'function') {
              clipboardAdapter.set_text(entry.text);
              return;
            }
            const { default: St } = await import('gi://St');
            St.Clipboard.get_default().set_text(
              St.ClipboardType.CLIPBOARD,
              entry.text
            );
          } catch {
            // Clipboard access is best effort.
          }
        },
        secondary: () => {
          if (store.remove(entry.id))
            scheduleSave();
        },
      },
    };
  }

  /**
   * Read the current clipboard once. Called by extension.js when the modal
   * opens; never from a key handler, so Ctrl+C/Ctrl+X typed into the search
   * field cannot overwrite history.
   *
   * @returns {Promise<void>}
   */
  function capture() {
    if (disposed)
      return Promise.resolve();

    if (clipboardAdapter && typeof clipboardAdapter.get_text === 'function') {
      try {
        remember(clipboardAdapter.get_text());
      } catch {
        // Adapter failures must not break opening the launcher.
      }
      capturePromise = Promise.resolve();
      return capturePromise;
    }

    capturePromise = loadSt().then(async St => {
      if (!St || disposed)
        return;
      const text = await readClipboardText(St);
      if (!disposed)
        remember(text);
    }).catch(() => {});

    return capturePromise;
  }

  return {
    id: PROVIDER_ID,
    title: 'Schowek',
    priority: ProviderPriority.LOW,
    timeoutMs: 300,
    warmUp() {
      loadSt();
    },
    capture,
    onOpen: capture,
    isQueryActive(query) {
      return parseClipboardQuery(query).active;
    },
    async search(query, context = {}) {
      const parsed = parseClipboardQuery(query);
      if (!parsed.active)
        return [];

      // Normally extension.js calls capture() on the closed -> open edge.
      // The fallback keeps direct provider/registry callers working, while an
      // existing capture promise (modal open) is always reused, never doubled.
      if (!capturePromise && (clipboardAdapter || StPromise))
        capture();

      if (capturePromise) {
        try {
          await capturePromise;
        } catch {
          // A failed capture leaves the persisted history usable.
        }
      }

      const limit = normalizeLimit(context?.limit, RESULT_LIMIT);
      if (limit === 0)
        return [];

      const needle = parsed.needle.toLowerCase();
      let entries = store.list();
      if (needle !== '') {
        entries = entries.filter(entry =>
          entry.text.toLowerCase().includes(needle)
        );
      }

      return entries.slice(0, limit).map(resultFor);
    },
    dispose() {
      if (disposed)
        return;
      cancelSave();
      flush();
      disposed = true;
    },
  };
}

export default createProvider;