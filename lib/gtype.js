// Per-UUID GType names.
//
// GType names are cached process-wide by GObject, so two copies of the
// extension (e.g. the installed one and a --uuid-suffix development copy)
// must not register the same name. This module is PURE: it imports neither
// GI nor Shell modules and works in a plain `gjs -m` process.

const MAX_TOKEN_LENGTH = 24;
const FALLBACK_TOKEN = 'default';

const GENERIC_DIRECTORIES = new Set([
  'lib',
  'src',
  'source',
  'js',
  'javascript',
  'ui',
  'dist',
  'build',
  'extension',
  'extensions',
  'module',
  'modules',
]);

function sanitizeToken(value) {
  const token = String(value ?? '')
    .replace(/[^A-Za-z0-9]/g, '')
    .slice(0, MAX_TOKEN_LENGTH);
  return token || FALLBACK_TOKEN;
}

/**
 * Ask the running Shell for the extension owning `uri`. The class is read
 * lazily from globalThis so a plain gjs process without a Shell session is
 * not an error. Any failure falls through to path-derived UUID detection.
 */
function extensionUUID(uri) {
  try {
    const Extension = globalThis?.Extension;
    if (!Extension || typeof Extension.lookupByURL !== 'function')
      return null;

    const extension = Extension.lookupByURL(uri);
    const uuid = extension?.uuid;
    if (typeof uuid === 'string' && uuid.trim() !== '')
      return uuid;
  } catch {
    // No Shell session or URI is not a registered extension.
  }
  return null;
}

/**
 * Split a URI into directory segments. The final segment is treated as a
 * file name (and dropped) unless the URI ends with a slash.
 *
 * @param {string} uri
 * @returns {{directories: string[], fileName: string|null}}
 */
function uriSegments(uri) {
  if (typeof uri !== 'string' || uri.trim() === '')
    return { directories: [], fileName: null };

  let text = uri.trim();
  const scheme = text.match(/^[A-Za-z][A-Za-z0-9+.-]*:/);
  if (scheme) {
    text = text.slice(scheme[0].length);
    if (text.startsWith('//')) {
      text = text.slice(2);
      const slash = text.indexOf('/');
      text = slash === -1 ? '' : text.slice(slash);
    }
  }

  text = text.split('#')[0].split('?')[0];
  try {
    text = decodeURIComponent(text);
  } catch {
    // Keep the raw text when it is not valid percent-encoding.
  }
  text = text.replace(/\\/g, '/');

  const hadTrailingSlash = text.endsWith('/');
  const parts = text.split('/').filter(part => part !== '' && part !== '.');
  let fileName = null;
  if (parts.length > 0 && !hadTrailingSlash && (text.includes('/') || parts.length > 1))
    fileName = parts.pop();

  return { directories: parts, fileName };
}

function deriveTokenFromURI(uri) {
  const { directories, fileName } = uriSegments(uri);
  if (directories.length === 0 && !fileName)
    return null;

  // GNOME extension UUIDs contain '@' (spotlight@haniewicz.dev).
  for (let i = directories.length - 1; i >= 0; i--) {
    if (directories[i].includes('@'))
      return directories[i];
  }

  // .../gnome-shell/extensions/<uuid>/... works even for UUIDs without '@'.
  const extensionsIndex = directories.lastIndexOf('extensions');
  if (extensionsIndex >= 0 && extensionsIndex + 1 < directories.length) {
    const candidate = directories[extensionsIndex + 1];
    if (!GENERIC_DIRECTORIES.has(candidate.toLowerCase()))
      return candidate;
  }

  // Last directory segment, skipping generic source folders like lib/ui.
  for (let i = directories.length - 1; i >= 0; i--) {
    if (!GENERIC_DIRECTORIES.has(directories[i].toLowerCase()))
      return directories[i];
  }

  // A plain URI with no directory still identifies something useful.
  return fileName;
}

/**
 * Stable alphanumeric token derived from the extension UUID.
 *
 * @param {string} uri usually `import.meta.url`
 * @returns {string} token matching [A-Za-z0-9]{1,24}
 */
export function gtypeToken(uri) {
  const uuid = extensionUUID(uri) ?? deriveTokenFromURI(uri);
  return sanitizeToken(uuid);
}

/**
 * Build a process-unique GType name, e.g. SpotlightModalA1b2c3.
 *
 * @param {string} base human-readable part, e.g. "Modal"
 * @param {string} uri usually `import.meta.url`
 * @returns {string} name matching /^Spotlight[A-Za-z0-9]+$/
 */
export function gtypeName(base, uri) {
  return `Spotlight${String(base ?? '')}${gtypeToken(uri)}`;
}

export default { gtypeToken, gtypeName };