// PURE module: no GI or shell-resource imports.
//
// SPARQL builder and row mapper for the local Tracker/localsearch index.
// Tracker's full-text index covers `nie:title` (the file name) as well as
// indexed document contents, so a single `fts:match` keeps filename searches
// fast without a full scan of every `nfo:FileName` triple.

const DEFAULT_LIMIT = 8;
const MAX_TERM_LENGTH = 64;
const MAX_FTS_TOKENS = 8;

const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/g;
const FTS_SEPARATOR_RE = /[^\p{L}\p{N}_]+/u;

function text(value) {
  if (value === undefined || value === null)
    return '';
  return String(value);
}

/**
 * Remove control characters, collapse whitespace and cap the term at 64
 * characters. This keeps user input from breaking the SPARQL token stream.
 *
 * @param {*} term
 * @returns {string}
 */
export function sanitizeTerm(term) {
  const value = text(term)
    .replace(CONTROL_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return value.slice(0, MAX_TERM_LENGTH);
}

/**
 * Escape a value for a double-quoted SPARQL string literal.
 *
 * @param {*} value
 * @returns {string}
 */
function escapeSparqlString(value) {
  return text(value)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');
}

function normalizeLimit(limit) {
  if (limit === undefined || limit === null)
    return DEFAULT_LIMIT;

  if (!Number.isInteger(limit))
    throw new TypeError('limit must be an integer');
  if (limit < 0)
    throw new RangeError('limit must not be negative');

  return limit;
}

function ftsExpression(term) {
  const tokens = term
    .split(FTS_SEPARATOR_RE)
    .filter(Boolean)
    .slice(0, MAX_FTS_TOKENS);

  return tokens
    .map(token => `${escapeSparqlString(token)}*`)
    .join(' ');
}

/**
 * Build a Tracker 3 SPARQL query.
 *
 * Filename matching goes through the FTS index (which indexes `nie:title`
 * and `nfo:fileName`). When `contentSearch` is false an additional FILTER
 * restricts the hits to the file name; when it is true, content matches from
 * the index are allowed through as well.
 *
 * @param {*} query
 * @param {{limit?: number, contentSearch?: boolean}} [options]
 * @returns {string}
 */
export function buildSearchQuery(query, options = {}) {
  const settings = options && typeof options === 'object' ? options : {};
  const term = sanitizeTerm(query);
  const limit = normalizeLimit(settings.limit);
  const contentSearch = settings.contentSearch === true;
  const fts = ftsExpression(term);

  if (term === '' || fts === '') {
    return [
      '# Empty search term: keep the query valid but return no rows',
      'SELECT ?url ?name WHERE {',
      '  ?file nie:url ?url ; nfo:fileName ?name .',
      '  FILTER(false)',
      `} LIMIT ${limit}`,
    ].join('\n');
  }

  return [
    '# Tracker 3: fts:match indexes nie:title / nfo:fileName and content',
    'SELECT ?url ?name WHERE {',
    `  ?file fts:match "${fts}" ;`,
    '        nie:url ?url ;',
    '        nfo:fileName ?name .',
    contentSearch
      ? '  FILTER(?name != "")'
      : `  FILTER(CONTAINS(LCASE(?name), LCASE("${escapeSparqlString(term)}")))`,
    `} LIMIT ${limit}`,
  ].join('\n');
}

function basename(path) {
  const value = text(path);
  const trimmed = value.endsWith('/') && value.length > 1
    ? value.slice(0, -1)
    : value;
  const index = trimmed.lastIndexOf('/');
  return index >= 0 ? trimmed.slice(index + 1) : trimmed;
}

function decodePath(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function fileUriToPath(url) {
  const value = text(url);
  if (!value.startsWith('file://'))
    return value;

  let path = value.slice('file://'.length);
  // file:///home/... -> /home/... ; tolerate file://localhost/...
  if (path.startsWith('localhost/'))
    path = path.slice('localhost'.length);
  if (!path.startsWith('/'))
    path = `/${path}`;

  const suffix = path.search(/[?#]/);
  if (suffix >= 0)
    path = path.slice(0, suffix);

  return decodePath(path);
}

function numberOrNull(value) {
  if (value === undefined || value === null || value === '')
    return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeModified(value) {
  if (value === undefined || value === null || value === '')
    return null;
  if (typeof value === 'number')
    return Number.isFinite(value) ? value : null;
  return String(value);
}

function rowValue(row, keys, index) {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(row, key)) {
      const value = row[key];
      if (value !== undefined && value !== null && value !== '')
        return value;
    }
  }
  if (index !== undefined && Object.prototype.hasOwnProperty.call(row, index))
    return row[index];
  return null;
}

/**
 * Map one Tracker cursor row to the provider-neutral shape.
 *
 * Accepts an object keyed by SPARQL variable name or an array-like row.
 * Missing fields are tolerated and normalized to empty strings / null / 0.
 *
 * @param {*} row
 * @returns {{path: string, name: string, mime: string, size: number|null,
 *   modified: (string|number|null), score: number}}
 */
export function mapRow(row) {
  const record = row && typeof row === 'object' ? row : {};

  const rawPath = rowValue(record, ['path', 'uri', 'url', 'file'], 0);
  const path = fileUriToPath(rawPath);

  const rawName = rowValue(record, ['name', 'title', 'fileName', 'filename'], 1);
  const name = text(rawName) || basename(path);

  const mime = text(rowValue(
    record,
    ['mime', 'mimeType', 'mime_type', 'contentType', 'contentTypeGuess'],
    2
  ));

  const size = numberOrNull(rowValue(
    record,
    ['size', 'fileSize', 'byteSize', 'bytes'],
    3
  ));

  const modified = normalizeModified(rowValue(
    record,
    ['modified', 'mtime', 'contentLastModified', 'lastModified', 'date'],
    4
  ));

  const score = numberOrNull(rowValue(
    record,
    ['score', 'rank', 'ftsRank'],
    5
  )) ?? 0;

  return { path, name, mime, size, modified, score };
}

export default { buildSearchQuery, mapRow, sanitizeTerm };