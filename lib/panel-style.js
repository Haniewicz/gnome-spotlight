/**
 * Pure panel-style resolver shared by the Shell actor and the acceptance
 * tests. It intentionally has no GI imports: the values are just strings and
 * numbers that lib/ui/modal.js applies to St actors.
 */

export const PANEL_RGB = '26,27,34';
export const DEFAULT_PANEL_OPACITY = 0.93;
export const MIN_PANEL_OPACITY = 0.5;
export const MAX_PANEL_OPACITY = 1.0;
export const DEFAULT_BLUR_RADIUS = 24;
export const MIN_BLUR_RADIUS = 0;
export const MAX_BLUR_RADIUS = 48;

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

/**
 * Round to at most three decimals so the CSS string is stable and the alpha
 * stays independent of GSettings' full double precision.
 */
function cssNumber(value) {
  return Number(value.toFixed(3));
}

export function clampPanelOpacity(value) {
  return clamp(
    finiteNumber(value, DEFAULT_PANEL_OPACITY),
    MIN_PANEL_OPACITY,
    MAX_PANEL_OPACITY
  );
}

export function clampBlurRadius(value) {
  return Math.round(clamp(
    finiteNumber(value, DEFAULT_BLUR_RADIUS),
    MIN_BLUR_RADIUS,
    MAX_BLUR_RADIUS
  ));
}

/**
 * Alpha of the dark veil drawn over the blurred backdrop. It keeps text
 * readable even when the panel itself is almost fully transparent.
 */
export function resolveBlurVeilAlpha(opacity) {
  return cssNumber(clamp(1 - clampPanelOpacity(opacity) + 0.15, 0, 1));
}

/**
 * @param {{opacity?: number, blurEnabled?: boolean, blurRadius?: number}} [options]
 * @returns {{background: string, blurRadius: number, requiresBlur: boolean}}
 */
export function resolvePanelStyle(options = {}) {
  const opacity = clampPanelOpacity(options?.opacity);
  const blurRadius = clampBlurRadius(options?.blurRadius);
  const requiresBlur = Boolean(options?.blurEnabled);

  return {
    background: `rgba(${PANEL_RGB},${cssNumber(opacity)})`,
    blurRadius,
    requiresBlur,
  };
}

export default {
  resolvePanelStyle,
  resolveBlurVeilAlpha,
  clampPanelOpacity,
  clampBlurRadius,
  DEFAULT_PANEL_OPACITY,
  MIN_PANEL_OPACITY,
  MAX_PANEL_OPACITY,
  DEFAULT_BLUR_RADIUS,
  MIN_BLUR_RADIUS,
  MAX_BLUR_RADIUS,
};