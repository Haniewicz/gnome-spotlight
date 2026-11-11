// PURE module: no GI or shell-resource imports.
//
// Parsing of `locate` output lives here so the Shell-side provider and the
// daemon share exactly one implementation (DESIGN §13).

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
 * This is pure so both providers can be tested without spawning a process.
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

export default parseLocateOutput;