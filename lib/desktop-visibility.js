/**
 * Pure helpers for desktop-specific application visibility.
 *
 * `Gio.AppInfo.should_show()` evaluates `OnlyShowIn`/`NotShowIn` against
 * `XDG_CURRENT_DESKTOP`. A daemon started from systemd's `default.target` can
 * run before the GNOME session exports that variable; `should_show()` then
 * reports `false` for every GNOME-only app (e.g. Extension Manager) for the
 * whole lifetime of the process. These helpers let the daemon re-evaluate the
 * desktop rules with an explicit fallback ("gnome"), so hidden/NoDisplay rules
 * still apply but GNOME-only apps stay searchable.
 *
 * PURE: no GI imports, covered by the plain `gjs -m` acceptance gate.
 */

export const FALLBACK_DESKTOPS = Object.freeze(['gnome']);

function normalize(value) {
  return String(value ?? '').trim().toLowerCase();
}

/**
 * Normalize a `XDG_CURRENT_DESKTOP`-style value (colon separated) into a
 * lower-case desktop list. Empty/invalid values fall back to GNOME.
 *
 * @param {string} [value]
 * @param {string[]} [fallback]
 * @returns {string[]}
 */
export function desktopList(value, fallback = FALLBACK_DESKTOPS) {
  const list = String(value ?? '')
    .split(':')
    .map(normalize)
    .filter(Boolean);
  if (list.length > 0)
    return list;
  return Array.isArray(fallback) && fallback.length > 0
    ? fallback.map(normalize)
    : [...FALLBACK_DESKTOPS];
}

function desktopSet(value) {
  return new Set(
    String(value ?? '')
      .split(';')
      .map(normalize)
      .filter(Boolean)
  );
}

/**
 * Decide whether an app should be visible on the given desktops, using the
 * same `OnlyShowIn`/`NotShowIn` semantics as the desktop entry spec.
 *
 * @param {{onlyShowIn?: string, notShowIn?: string,
 *   desktops?: string[]}} [options]
 * @returns {boolean}
 */
export function shouldShowOnDesktops(options = {}) {
  const desktops = Array.isArray(options?.desktops) && options.desktops.length
    ? options.desktops.map(normalize)
    : [...FALLBACK_DESKTOPS];

  const only = desktopSet(options?.onlyShowIn);
  if (only.size > 0 && !desktops.some(desktop => only.has(desktop)))
    return false;

  const not = desktopSet(options?.notShowIn);
  if (not.size > 0 && desktops.some(desktop => not.has(desktop)))
    return false;

  return true;
}

export default {
  desktopList,
  shouldShowOnDesktops,
  FALLBACK_DESKTOPS,
};
