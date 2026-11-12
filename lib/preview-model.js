// PURE module: no GI or shell-resource imports.
//
// The file-preview decisions (kind, metadata, text excerpt) live here so the
// Shell-side panel only deals with actors and asynchronous I/O.

import { humanSize } from './format.js';

const DEFAULT_MAX_LINES = 200;

const IMAGE_EXTENSIONS = new Set([
  'avif', 'bmp', 'gif', 'heic', 'heif', 'ico', 'jpeg', 'jpg', 'jxl',
  'png', 'svg', 'tif', 'tiff', 'webp',
]);

const OFFICE_EXTENSIONS = new Set([
  'doc', 'docm', 'docx', 'dot', 'dotx', 'epub', 'key', 'numbers', 'odg',
  'odp', 'ods', 'odt', 'pages', 'ppt', 'pptm', 'pptx', 'rtf', 'xls',
  'xlsb', 'xlsm', 'xlsx',
]);

const TEXT_EXTENSIONS = new Set([
  'bash', 'c', 'conf', 'cfg', 'cjs', 'cpp', 'cs', 'css', 'csv', 'desktop',
  'diff', 'env', 'go', 'h', 'hpp', 'htm', 'html', 'ini', 'java', 'js',
  'json', 'jsx', 'log', 'lua', 'm', 'md', 'markdown', 'mjs', 'patch', 'php',
  'pl', 'py', 'rb', 'rs', 'scss', 'sh', 'sql', 'tex', 'toml', 'ts', 'tsv',
  'tsx', 'txt', 'vue', 'xml', 'yaml', 'yml', 'zsh',
]);

// Common extension-less text files. Paths without a known basename are kept
// in the conservative "binary" bucket because open() must not pump arbitrary
// bytes into an St.Label.
const TEXT_BASENAMES = new Set([
  '.bashrc', '.env', '.gitconfig', '.gitignore', '.profile', '.zshrc',
  'authors', 'changelog', 'copying', 'dockerfile', 'license', 'licence',
  'makefile', 'notice', 'readme', 'todo',
]);

const MIME_KINDS = new Map([
  ['application/pdf', 'pdf'],
  ['application/x-pdf', 'pdf'],
  ['application/msword', 'office'],
  ['application/rtf', 'office'],
  ['application/vnd.ms-excel', 'office'],
  ['application/vnd.ms-powerpoint', 'office'],
  ['application/vnd.oasis.opendocument.presentation', 'office'],
  ['application/vnd.oasis.opendocument.spreadsheet', 'office'],
  ['application/vnd.oasis.opendocument.text', 'office'],
  ['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'office'],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'office'],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'office'],
  ['application/epub+zip', 'office'],
  ['application/json', 'text'],
  ['application/javascript', 'text'],
  ['application/xml', 'text'],
  ['application/x-sh', 'text'],
  ['application/x-yaml', 'text'],
  ['application/yaml', 'text'],
]);

function stringValue(value) {
  return value === null || value === undefined ? '' : String(value);
}

function basename(path) {
  const value = stringValue(path).trim();
  if (value === '')
    return '';
  const parts = value.split(/[\\/]/);
  return parts[parts.length - 1] ?? '';
}

function extensionOf(name) {
  const value = stringValue(name).toLowerCase();
  const dot = value.lastIndexOf('.');
  if (dot < 0 || dot === value.length - 1)
    return '';
  return value.slice(dot + 1);
}

function isMime(value) {
  return /^[a-z][a-z0-9.+-]*\/[a-z0-9.+-]+$/i.test(value);
}

function classifyMime(mime) {
  const value = mime.toLowerCase();
  const exact = MIME_KINDS.get(value);
  if (exact)
    return exact;
  if (value.startsWith('image/'))
    return 'image';
  if (value.startsWith('text/'))
    return 'text';
  return 'binary';
}

/**
 * Classify a path (or a MIME type) without touching the filesystem.
 *
 * @param {*} path
 * @returns {'image'|'pdf'|'text'|'office'|'binary'}
 */
export function classify(path) {
  const value = stringValue(path).trim();
  if (value === '')
    return 'binary';

  if (isMime(value))
    return classifyMime(value);

  const name = basename(value).toLowerCase();
  const extension = extensionOf(name);

  if (extension === 'pdf')
    return 'pdf';
  if (IMAGE_EXTENSIONS.has(extension))
    return 'image';
  if (OFFICE_EXTENSIONS.has(extension))
    return 'office';
  if (TEXT_EXTENSIONS.has(extension))
    return 'text';

  if (TEXT_BASENAMES.has(name))
    return 'text';

  return 'binary';
}

function safeCall(object, method) {
  if (!object || typeof object[method] !== 'function')
    return undefined;
  try {
    return object[method]();
  } catch {
    return undefined;
  }
}

function statSize(stat) {
  if (typeof stat === 'number')
    return stat;

  const direct = stat?.size ?? stat?.sizeBytes ?? stat?.bytes;
  if (direct !== undefined && direct !== null)
    return direct;

  return safeCall(stat, 'get_size');
}

function statPath(stat) {
  return stat?.path ?? stat?.filePath ?? stat?.filename ?? stat?.name ?? '';
}

function statMtime(stat) {
  return stat?.mtime ?? stat?.modified ?? stat?.mtimeMs ?? stat?.mtime_ms ??
    stat?.lastModified ?? safeCall(stat, 'get_modification_date_time');
}

function toDate(value) {
  if (value instanceof Date)
    return Number.isNaN(value.getTime()) ? null : value;

  if (typeof value === 'number' && Number.isFinite(value)) {
    // Accept both seconds (stat mtime) and milliseconds (Date.now()).
    return new Date(value < 1e12 ? value * 1000 : value);
  }

  if (value && typeof value.to_unix === 'function') {
    try {
      return new Date(value.to_unix() * 1000);
    } catch {
      return null;
    }
  }

  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  return null;
}

function formatMtime(value) {
  if (value === null || value === undefined || value === '')
    return '—';

  // A pre-formatted string is passed through unchanged; this keeps the helper
  // useful for providers that already supply a display value.
  if (typeof value === 'string' && Number.isNaN(new Date(value).getTime()))
    return value;

  const date = toDate(value);
  if (!date)
    return typeof value === 'string' ? value : '—';

  try {
    if (typeof Intl === 'object' && typeof Intl.DateTimeFormat === 'function') {
      return new Intl.DateTimeFormat('pl-PL', {
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(date);
    }
  } catch {
    // Fall through to the deterministic ISO-like form.
  }

  const pad = number => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * Build the three metadata rows shown for a selected file.
 *
 * @param {object|number|null|undefined} stat plain object, Gio.FileInfo-like
 *   object or a raw byte count
 * @returns {[string, string][]}
 */
export function formatMeta(stat) {
  const value = stat && typeof stat === 'object' ? stat : { size: stat };
  return [
    ['Rozmiar', humanSize(statSize(value))],
    ['Zmodyfikowano', formatMtime(statMtime(value))],
    ['Ścieżka', stringValue(statPath(value))],
  ];
}

function bytesOf(buffer) {
  if (buffer instanceof Uint8Array)
    return buffer;
  if (typeof ArrayBuffer !== 'undefined' && buffer instanceof ArrayBuffer)
    return new Uint8Array(buffer);
  if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(buffer))
    return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  if (Array.isArray(buffer))
    return Uint8Array.from(buffer);
  return null;
}

function decodeBytes(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  } catch {
    // TextDecoder is available in gjs, but keep a no-throw fallback for
    // unusual hosts. Invalid sequences become replacement characters below.
    let text = '';
    for (let index = 0; index < bytes.length; index++)
      text += String.fromCharCode(bytes[index]);
    return text;
  }
}

function normalizeLimit(maxLines) {
  if (maxLines === undefined || maxLines === null)
    return DEFAULT_MAX_LINES;
  const value = Number(maxLines);
  if (!Number.isFinite(value))
    return DEFAULT_MAX_LINES;
  return Math.max(0, Math.floor(value));
}

/**
 * Return the first `maxLines` lines of a file buffer.
 *
 * CRLF and bare CR are normalized to LF, invalid UTF-8 is decoded with U+FFFD
 * replacement characters, and the whole function never throws.
 *
 * @param {string|Uint8Array|ArrayBuffer|ArrayBufferView|number[]|null} buffer
 * @param {number} [maxLines]
 * @returns {{text: string, truncated: boolean}}
 */
export function textSnippet(buffer, maxLines = DEFAULT_MAX_LINES) {
  let decoded;
  if (typeof buffer === 'string') {
    decoded = buffer;
  } else {
    const bytes = bytesOf(buffer);
    if (!bytes)
      return { text: '', truncated: false };
    decoded = decodeBytes(bytes);
  }

  decoded = decoded.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  const lines = decoded.split('\n');
  // A trailing newline terminates the last line; it is not an extra line.
  if (lines.length > 0 && lines[lines.length - 1] === '')
    lines.pop();

  const limit = normalizeLimit(maxLines);
  const truncated = lines.length > limit;
  return {
    text: lines.slice(0, limit).join('\n'),
    truncated,
  };
}

export default { classify, formatMeta, textSnippet };