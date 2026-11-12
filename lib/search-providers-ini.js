// PURE module: no GI or shell-resource imports.
//
// Parser for GNOME Shell native search provider descriptors:
//   [Shell Search Provider]
//   DesktopId=org.gnome.Settings.desktop
//   BusName=org.gnome.Settings.SearchProvider
//   ObjectPath=/org/gnome/Settings/SearchProvider
//   Version=2
//   AutoStart=true
//
// The daemon (searchd/providers/remote.js) reads the files and calls this
// module; tests can exercise the format without a session bus or Gio.

const SECTION = 'shell search provider';
const DEFAULT_VERSION = 2;

function unquote(value) {
  const text = String(value ?? '').trim();
  if (text.length >= 2) {
    const first = text[0];
    const last = text[text.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'"))
      return text.slice(1, -1).trim();
  }
  return text;
}

function stripInlineComment(value) {
  // Keep '#' inside a value unless it is clearly a trailing comment. This is
  // enough for ordinary .ini files and avoids cutting paths such as
  // "/tmp/a#b" that a provider might legitimately use.
  let quote = '';
  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    if (quote !== '') {
      if (character === quote && value[index - 1] !== '\\')
        quote = '';
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if ((character === '#' || character === ';') &&
        (index === 0 || /\s/.test(value[index - 1])))
      return value.slice(0, index).trim();
  }
  return value.trim();
}

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null)
    return fallback;
  const text = String(value).trim().toLowerCase();
  if (['true', 'yes', 'on', '1'].includes(text))
    return true;
  if (['false', 'no', 'off', '0'].includes(text))
    return false;
  return fallback;
}

function parseVersion(value) {
  if (value === undefined || value === null || String(value).trim() === '')
    return DEFAULT_VERSION;
  const number = Number(String(value).trim());
  if (!Number.isFinite(number) || number < 0)
    return DEFAULT_VERSION;
  return Math.floor(number);
}

/**
 * Parse one GNOME Shell search provider .ini file.
 *
 * Tolerates comments (`#` and `;`), CRLF, a BOM, whitespace and quoted values.
 * Returns null when the [Shell Search Provider] section is absent or when a
 * mandatory BusName/ObjectPath is missing.
 *
 * @param {string} text
 * @returns {{desktopId: string, busName: string, objectPath: string,
 *   version: number, autoStart: boolean}|null}
 */
export function parseSearchProviderIni(text) {
  if (typeof text !== 'string')
    return null;

  const values = new Map();
  let inSection = false;
  let sawSection = false;

  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#') || line.startsWith(';'))
      continue;

    if (line.startsWith('[')) {
      const end = line.indexOf(']');
      if (end < 0)
        continue;
      const section = line.slice(1, end).trim().toLowerCase();
      inSection = section === SECTION;
      if (inSection)
        sawSection = true;
      continue;
    }

    if (!inSection)
      continue;

    const equals = line.indexOf('=');
    const colon = line.indexOf(':');
    let separator = equals;
    if (separator < 0 || (colon >= 0 && colon < separator))
      separator = colon;
    if (separator <= 0)
      continue;

    const key = line.slice(0, separator).trim().toLowerCase();
    if (key === '')
      continue;

    const value = unquote(stripInlineComment(line.slice(separator + 1)));
    values.set(key, value);
  }

  if (!sawSection)
    return null;

  const busName = values.get('busname') ?? '';
  const objectPath = values.get('objectpath') ?? '';
  if (busName === '' || objectPath === '')
    return null;

  return {
    desktopId: values.get('desktopid') ?? '',
    busName,
    objectPath,
    version: parseVersion(values.get('version')),
    autoStart: parseBoolean(values.get('autostart'), false),
  };
}

function asList(value) {
  if (value === undefined || value === null)
    return [];
  return Array.isArray(value) ? value : [value];
}

function joinPath(base, name) {
  if (base === '')
    return name;
  return String(base).replace(/\/+$/, '') + '/' + String(name).replace(/^\/+/, '');
}

function isIniFile(value) {
  return /\.ini$/i.test(String(value).trim());
}

function entryPaths(entry) {
  if (typeof entry === 'string') {
    const value = entry.trim();
    return value === '' ? [] : [value];
  }

  if (Array.isArray(entry)) {
    if (entry.length === 0)
      return [];
    const [base, ...names] = entry;
    if (names.length === 0)
      return entryPaths(base);
    return names
      .map(name => joinPath(String(base ?? ''), String(name ?? '')))
      .filter(Boolean);
  }

  if (entry && typeof entry === 'object') {
    const base = entry.dir ?? entry.directory ?? entry.path ?? '';
    const files = asList(entry.files ?? entry.names ?? entry.entries);
    if (files.length === 0)
      return entryPaths(base);
    return files
      .map(name => joinPath(String(base ?? ''), String(name ?? '')))
      .filter(Boolean);
  }

  return [];
}

/**
 * Build the ordered, de-duplicated list of .ini paths from the entries the
 * caller obtained by listing the user and system directories.
 *
 * The function is PURE and deliberately receives lists of strings (or
 * `[directory, ...fileNames]` pairs); the daemon owns directory iteration.
 * User paths come first so they can override a system provider.
 *
 * @param {{userDir?: string|string[], systemDir?: string|string[],
 *   userFiles?: string|string[], systemFiles?: string|string[]}} [options]
 * @returns {string[]}
 */
export function discoverProviders(options = {}) {
  const source = options && typeof options === 'object' ? options : {};
  const userEntries = [
    ...asList(source.userDir),
    ...asList(source.userFiles),
  ];
  const systemEntries = [
    ...asList(source.systemDir),
    ...asList(source.systemFiles),
  ];

  const seen = new Set();
  const paths = [];

  const add = path => {
    const value = String(path ?? '').trim();
    if (!isIniFile(value) || seen.has(value))
      return;
    seen.add(value);
    paths.push(value);
  };

  for (const entry of userEntries) {
    for (const path of entryPaths(entry))
      add(path);
  }
  for (const entry of systemEntries) {
    for (const path of entryPaths(entry))
      add(path);
  }

  return paths;
}

export const SEARCH_PROVIDER_SECTION = 'Shell Search Provider';
export const DEFAULT_SEARCH_PROVIDER_VERSION = DEFAULT_VERSION;