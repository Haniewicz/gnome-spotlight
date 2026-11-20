/**
 * Pure panel-style resolver shared by the Shell actor and the acceptance
 * tests. It intentionally has no GI imports: the values are just strings and
 * numbers that lib/ui/modal.js applies to St actors.
 */

export const PANEL_RGB = '26,27,34';
export const PANEL_RADIUS = 18;

// Delikatna obwódka panelu — ta sama wartość co `border` w
// `.spotlight-modal` (stylesheet.css). 1 px półprzezroczystej bieli oddziela
// panel od tła, nie dodając drugiego widocznego, zaokrąglonego kształtu.
export const PANEL_BORDER_WIDTH = 1;
export const PANEL_BORDER_RGBA = '255,255,255,0.16';
export const DEFAULT_PANEL_OPACITY = 0.93;
export const MIN_PANEL_OPACITY = 0.5;
export const MAX_PANEL_OPACITY = 1.0;
export const DEFAULT_BLUR_RADIUS = 24;
export const MIN_BLUR_RADIUS = 0;
export const MAX_BLUR_RADIUS = 48;
export const DEFAULT_BLUR_DIM = 0.0;
export const MIN_BLUR_DIM = 0.0;
export const MAX_BLUR_DIM = 1.0;
// Keep a sliver of the blurred backdrop visible even at maximum dimming.
export const MAX_BLUR_VEIL_ALPHA = 0.95;

/**
 * Inline style for the modal actor while the blurred backdrop paints the
 * surface. It must clear EVERY rounded shape the theme draws on the modal —
 * background, border, radius AND box-shadow — so the blurred backdrop is the
 * only rounded silhouette. Leaving the CSS box-shadow / border-radius active
 * rasterizes a second arc (St draws the shadow in software around the 18px
 * radius) next to the Blur my Shell corner mask, which is exactly the kind of
 * two-arc mismatch that produced scraps/steps in the corners. The CSS keeps
 * the shadow for the no-blur path and the acceptance gate; this override
 * disables it only while blur paints.
 */
export const BLUR_SURFACE_STYLE =
  'background-color: transparent; border: none; box-shadow: none; border-radius: 0;';

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
 * Extra darkening of the blurred backdrop, independent of panel-opacity.
 * 0 keeps the historical look; 1 is the maximum (veil alpha capped at 0.95).
 */
export function clampBlurDim(value) {
  return clamp(
    finiteNumber(value, DEFAULT_BLUR_DIM),
    MIN_BLUR_DIM,
    MAX_BLUR_DIM
  );
}

/**
 * Alpha of the dark veil drawn over the blurred backdrop. It keeps text
 * readable even when the panel itself is almost fully transparent. The
 * historical base is `1 - opacity + 0.15`; `dim` is an independent user
 * slider that adds contrast without changing the panel's own opacity.
 */
export function resolveBlurVeilAlpha(opacity, dim = 0) {
  return cssNumber(clamp(
    1 - clampPanelOpacity(opacity) + 0.15 + clampBlurDim(dim),
    0,
    MAX_BLUR_VEIL_ALPHA
  ));
}

/**
 * Inline style for the readability veil in blur mode. The veil is the only
 * actor that paints the pool surface (background + border + radius) while the
 * Blur my Shell effect rounds the backdrop, so the border has to live here:
 * the modal itself must stay transparent/square (BLUR_SURFACE_STYLE) and may
 * not draw a second arc next to the blur corner mask.
 *
 * @param {{veilAlpha?: number, radius?: number}} [options]
 * @returns {string} St inline style
 */
export function resolveBlurVeilStyle(options = {}) {
  const veilAlpha = clamp(finiteNumber(options?.veilAlpha, 0.65), 0, 1);
  const radius = Math.max(0, Math.round(
    finiteNumber(options?.radius, PANEL_RADIUS)
  ));

  return (
    `background-color: rgba(${PANEL_RGB},${cssNumber(veilAlpha)}); ` +
    `border: ${PANEL_BORDER_WIDTH}px solid rgba(${PANEL_BORDER_RGBA}); ` +
    `border-radius: ${radius}px;`
  );
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
  resolveBlurVeilStyle,
  resolveBlurVeilAlpha,
  clampPanelOpacity,
  clampBlurRadius,
  clampBlurDim,
  BLUR_SURFACE_STYLE,
  PANEL_BORDER_WIDTH,
  PANEL_BORDER_RGBA,
  PANEL_RADIUS,
  DEFAULT_PANEL_OPACITY,
  MIN_PANEL_OPACITY,
  MAX_PANEL_OPACITY,
  DEFAULT_BLUR_RADIUS,
  MIN_BLUR_RADIUS,
  MAX_BLUR_RADIUS,
  DEFAULT_BLUR_DIM,
  MIN_BLUR_DIM,
  MAX_BLUR_DIM,
  MAX_BLUR_VEIL_ALPHA,
};