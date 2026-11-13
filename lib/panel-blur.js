/**
 * Pure planning helpers for the real "clone the desktop background" blur.
 *
 * This module deliberately has no GI imports: the Shell glue in
 * lib/ui/modal.js owns the Clutter actors, while the geometry and radius
 * decisions stay testable with plain `gjs -m`.
 */

export const MIN_BLUR_RADIUS = 0;
export const MAX_BLUR_RADIUS = 48;
export const DEFAULT_BLUR_RADIUS = 24;

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

/**
 * Clamp a GSettings blur radius to the range supported by the panel style.
 * Fractional values are rounded because Shell.BlurEffect expects an integer
 * radius.
 */
export function clampRadius(value) {
  const radius = finiteNumber(value, DEFAULT_BLUR_RADIUS);
  return Math.round(Math.max(
    MIN_BLUR_RADIUS,
    Math.min(MAX_BLUR_RADIUS, radius)
  ));
}

/**
 * Offset that makes a clone of the whole background show the part which is
 * underneath the panel. Clutter positions the clone in panel-local
 * coordinates, so the global panel origin has to be subtracted.
 *
 * @param {{panelX?: number, panelY?: number}} [position]
 * @returns {{x: number, y: number}}
 */
export function cloneOffset(position = {}) {
  return {
    x: negateOffset(position?.panelX),
    y: negateOffset(position?.panelY),
  };
}

/**
 * Negate an offset without ever producing `-0`. `assert.deepStrictEqual`
 * treats `-0` and `0` as different values, so a panel anchored at the origin
 * would report a spurious mismatch even though both offsets place the clone
 * at the same pixel.
 */
function negateOffset(value) {
  const number = finiteNumber(value, 0);
  return number === 0 ? 0 : -number;
}

/**
 * Decide whether a real backdrop clone can be built. Returning `{clone:false}`
 * for the normal blur-off path keeps the semi-transparent CSS background as
 * the only backdrop, without pretending that an effect exists.
 *
 * @param {{
 *   enabled?: boolean,
 *   available?: boolean,
 *   radius?: number,
 *   panelX?: number,
 *   panelY?: number,
 * }} [options]
 */
export function planPanelBlur(options = {}) {
  if (!options?.enabled)
    return { clone: false };

  if (options.available === false)
    return { clone: false, unavailable: true };

  return {
    clone: true,
    radius: clampRadius(options.radius),
    offset: cloneOffset(options),
  };
}

export default {
  clampRadius,
  cloneOffset,
  planPanelBlur,
  MIN_BLUR_RADIUS,
  MAX_BLUR_RADIUS,
  DEFAULT_BLUR_RADIUS,
};