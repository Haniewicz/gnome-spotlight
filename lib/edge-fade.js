/**
 * Pure helpers for the progressive edge blur of the results list.
 *
 * The results list is the only scrollable part of the panel. When it
 * overflows, the row that is cut by the viewport edge looked harsh: a hard
 * horizontal cut through icon and text. The effect attached to the scroll view
 * blurs and fades the content toward the top/bottom edge, with the strength
 * following the current scroll position:
 *
 *   - top edge blurs only once the list is scrolled away from the first row,
 *   - bottom edge blurs only while there is more content below,
 *   - both ramp in/out over EDGE_FADE_RAMP_PX of scrolling.
 *
 * Geometry decisions stay here so the acceptance gate can exercise them with
 * plain `gjs -m` (no GI imports).
 */

export const EDGE_FADE_HEIGHT_PX = 40;
export const EDGE_FADE_BLUR_PX = 8;
export const EDGE_FADE_RAMP_PX = 30;
export const EDGE_FADE_ALPHA_AT_EDGE = 0.25;

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

/**
 * Strengths of the top/bottom edge blur for the current scroll position.
 *
 * @param {{value?: number, pageSize?: number, upper?: number,
 *   rampPx?: number}} [options] adjustment values from StScrollView.vadjustment
 * @returns {{overflow: boolean, topStrength: number, bottomStrength: number,
 *   maxScroll: number}}
 */
export function resolveEdgeFade(options = {}) {
  const value = Math.max(0, finiteNumber(options?.value, 0));
  const pageSize = Math.max(0, finiteNumber(options?.pageSize, 0));
  const upper = Math.max(0, finiteNumber(options?.upper, 0));
  const ramp = Math.max(1, finiteNumber(options?.rampPx, EDGE_FADE_RAMP_PX));

  const maxScroll = Math.max(0, upper - pageSize);
  // A sub-pixel overflow is just rounding noise, not hidden content.
  if (maxScroll <= 0.5) {
    return {
      overflow: false,
      topStrength: 0,
      bottomStrength: 0,
      maxScroll: 0,
    };
  }

  const position = clamp(value, 0, maxScroll);
  return {
    overflow: true,
    topStrength: clamp(position / ramp, 0, 1),
    bottomStrength: clamp((maxScroll - position) / ramp, 0, 1),
    maxScroll,
  };
}

/**
 * Fragment shader for the progressive edge blur.
 *
 * `strength` depends on the distance to the top/bottom edge (0 in the middle,
 * 1 at the edge) and is multiplied by the per-edge strengths from
 * resolveEdgeFade(). The kernel is a small 9-tap box blur whose radius grows
 * with the strength, so the effect is cheap and vanishes completely in the
 * middle of the list. The alpha fade at the very edge hides the hard cut line.
 */
export const EDGE_FADE_SHADER = `
uniform sampler2D tex;
uniform float width;
uniform float height;
uniform float top_strength;
uniform float bottom_strength;
uniform float fade_height;
uniform float blur_px;
uniform float alpha_at_edge;

void main(void) {
  vec2 uv = cogl_tex_coord_in[0].st;
  vec2 texel = vec2(1.0 / max(width, 1.0), 1.0 / max(height, 1.0));
  float px = uv.y * height;
  float top_t = 1.0 - clamp(px / max(fade_height, 1.0), 0.0, 1.0);
  float bottom_t = 1.0 - clamp(
    (height - px) / max(fade_height, 1.0), 0.0, 1.0);
  float strength = max(top_t * top_strength, bottom_t * bottom_strength);
  float radius = blur_px * strength;
  vec2 off = texel * radius;

  vec4 color = texture2D(tex, uv) * 0.28;
  color += texture2D(tex, uv + vec2(off.x, 0.0)) * 0.12;
  color += texture2D(tex, uv - vec2(off.x, 0.0)) * 0.12;
  color += texture2D(tex, uv + vec2(0.0, off.y)) * 0.12;
  color += texture2D(tex, uv - vec2(0.0, off.y)) * 0.12;
  color += texture2D(tex, uv + vec2(off.x, off.y)) * 0.06;
  color += texture2D(tex, uv + vec2(off.x, -off.y)) * 0.06;
  color += texture2D(tex, uv + vec2(-off.x, off.y)) * 0.06;
  color += texture2D(tex, uv + vec2(-off.x, -off.y)) * 0.06;

  float fade = mix(1.0, alpha_at_edge, strength);
  cogl_color_out = vec4(color.rgb * fade, color.a * fade);
}
`;

export default {
  resolveEdgeFade,
  EDGE_FADE_SHADER,
  EDGE_FADE_HEIGHT_PX,
  EDGE_FADE_BLUR_PX,
  EDGE_FADE_RAMP_PX,
  EDGE_FADE_ALPHA_AT_EDGE,
};
