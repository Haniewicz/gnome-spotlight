/**
 * PURE window geometry planner.
 *
 * This module intentionally has no GI/Shell imports: the Shell provider passes
 * plain `{x, y, width, height}` objects and the same code is exercised by the
 * `gjs -m` unit tests and the headless smoke script.
 */

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeRect(rect) {
  return {
    x: number(rect?.x),
    y: number(rect?.y),
    width: Math.max(0, number(rect?.width)),
    height: Math.max(0, number(rect?.height)),
  };
}

function normalizeSide(side) {
  return String(side ?? '').toLowerCase();
}

/**
 * Split a work area into two full-height halves.
 *
 * The left half uses `floor(width / 2)`; the right half takes the remainder,
 * so the two widths always add up to `workArea.width` (no 1-pixel gap or
 * overlap on odd widths).
 *
 * @param {{x: number, y: number, width: number, height: number}} workArea
 * @param {'left'|'right'} side
 * @returns {{x: number, y: number, width: number, height: number}}
 */
export function planTile(workArea, side) {
  const area = normalizeRect(workArea);
  const leftWidth = Math.floor(area.width / 2);

  if (normalizeSide(side) === 'right') {
    return {
      x: area.x + leftWidth,
      y: area.y,
      width: area.width - leftWidth,
      height: area.height,
    };
  }

  return {
    x: area.x,
    y: area.y,
    width: leftWidth,
    height: area.height,
  };
}

function ratio(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed))
    return fallback;
  return Math.min(1, Math.max(0, parsed));
}

/**
 * Center a rectangle inside a work area. Ratios are clamped to 0..1; the
 * default half-size is the "maximize without full screen" use case.
 *
 * @param {{x: number, y: number, width: number, height: number}} workArea
 * @param {{widthRatio?: number, heightRatio?: number}} [options]
 * @returns {{x: number, y: number, width: number, height: number}}
 */
export function planCenter(workArea, options = {}) {
  const area = normalizeRect(workArea);
  const widthRatio = ratio(options?.widthRatio, 0.5);
  const heightRatio = ratio(options?.heightRatio, 0.5);
  const width = Math.floor(area.width * widthRatio);
  const height = Math.floor(area.height * heightRatio);

  return {
    x: area.x + Math.floor((area.width - width) / 2),
    y: area.y + Math.floor((area.height - height) / 2),
    width,
    height,
  };
}

/**
 * Intersect a rectangle with a work area. A rectangle outside the work area
 * (including negative coordinates on a monitor placed left/above the primary
 * one) collapses to zero width/height at the nearest edge.
 *
 * @param {{x: number, y: number, width: number, height: number}} rect
 * @param {{x: number, y: number, width: number, height: number}} workArea
 * @returns {{x: number, y: number, width: number, height: number}}
 */
export function clampToWorkArea(rect, workArea) {
  const target = normalizeRect(workArea);
  const source = normalizeRect(rect);

  const left = Math.max(source.x, target.x);
  const top = Math.max(source.y, target.y);
  const right = Math.min(source.x + source.width, target.x + target.width);
  const bottom = Math.min(source.y + source.height, target.y + target.height);

  return {
    x: Math.min(left, target.x + target.width),
    y: Math.min(top, target.y + target.height),
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  };
}

export default { planTile, planCenter, clampToWorkArea };