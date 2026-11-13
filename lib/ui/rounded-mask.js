// Rounded-corner mask for the blurred backdrop.
//
// The geometry helpers at the top are PURE: they do not import GI or Shell
// modules, so the acceptance gate can exercise them with plain `gjs -m`. The
// effect factory at the bottom receives GObject/Clutter/Cogl from the Shell
// layer, which keeps this module importable outside a Shell session.

import { gtypeName } from '../gtype.js';

const MIN_RADIUS = 0;
const EDGE_WIDTH = 1;

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function smoothstep(edge0, edge1, value) {
  const t = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

function dimensions(widthOrOptions, maybeHeight) {
  let width = widthOrOptions;
  let height = maybeHeight;

  if (widthOrOptions && typeof widthOrOptions === 'object') {
    width = widthOrOptions.width;
    height = widthOrOptions.height;
  }

  let resolvedWidth = Math.max(0, finiteNumber(width, 0));
  let resolvedHeight = Math.max(0, finiteNumber(height, 0));

  // A single known dimension is enough to derive a sensible cap; callers that
  // provide neither get a zero-radius mask instead of an unbounded one.
  if (resolvedWidth <= 0 && resolvedHeight > 0)
    resolvedWidth = resolvedHeight;
  if (resolvedHeight <= 0 && resolvedWidth > 0)
    resolvedHeight = resolvedWidth;

  return { width: resolvedWidth, height: resolvedHeight };
}

/**
 * Clamp a CSS border radius to half of the shorter side of the panel.
 *
 * Supports both `clampMaskRadius(value, width, height)` and
 * `clampMaskRadius(value, { width, height })`.
 *
 * @param {number} value requested radius in pixels
 * @param {number|{width?: number, height?: number}} [widthOrOptions]
 * @param {number} [maybeHeight]
 * @returns {number}
 */
export function clampMaskRadius(value, widthOrOptions, maybeHeight) {
  const radius = Math.max(MIN_RADIUS, finiteNumber(value, MIN_RADIUS));
  const { width, height } = dimensions(widthOrOptions, maybeHeight);
  const maximum = Math.max(0, Math.min(width, height) / 2);
  return Math.min(radius, maximum);
}

/**
 * Coverage of a rounded rectangle at a pixel coordinate.
 *
 * The coordinate system starts at the top-left corner of the panel. The
 * returned value is 1 inside, 0 outside and about 0.5 on the antialiased
 * one-pixel edge, matching the GLSL used by the mask effect.
 *
 * @param {{x?: number, y?: number, width?: number, height?: number,
 *   radius?: number}} [options]
 * @returns {number} coverage in the [0, 1] range
 */
export function maskCoverage(options = {}) {
  const width = Math.max(0, finiteNumber(options?.width, 0));
  const height = Math.max(0, finiteNumber(options?.height, 0));
  if (width <= 0 || height <= 0)
    return 0;

  const radius = clampMaskRadius(options?.radius, width, height);
  const x = finiteNumber(options?.x, 0);
  const y = finiteNumber(options?.y, 0);

  const halfWidth = width / 2;
  const halfHeight = height / 2;
  const qx = Math.abs(x - halfWidth) - (halfWidth - radius);
  const qy = Math.abs(y - halfHeight) - (halfHeight - radius);

  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  const inside = Math.min(Math.max(qx, qy), 0);
  const distance = outside + inside - radius;
  const coverage = 1 - smoothstep(
    -EDGE_WIDTH / 2,
    EDGE_WIDTH / 2,
    distance
  );

  return clamp(coverage, 0, 1);
}

export const ROUNDED_MASK_SHADER = `
uniform sampler2D tex;
uniform float radius;
uniform float width;
uniform float height;

float rounded_box_distance(vec2 point, vec2 half_size, float corner_radius) {
  vec2 q = abs(point - half_size) - (half_size - vec2(corner_radius));
  return length(max(q, vec2(0.0))) + min(max(q.x, q.y), 0.0) - corner_radius;
}

void main(void) {
  vec2 uv = cogl_tex_coord_in[0].st;
  vec2 size = vec2(max(width, 1.0), max(height, 1.0));
  vec2 point = uv * size;
  float distance = rounded_box_distance(point, size * 0.5, radius);
  float coverage = 1.0 - smoothstep(-0.5, 0.5, distance);
  vec4 color = texture2D(tex, uv);
  cogl_color_out = vec4(color.rgb, color.a * coverage);
}
`;

function splitShaderSource(source) {
  const mainIndex = String(source).search(
    /void\s+main\s*(?:\(\s*(?:void)?\s*\))?\s*\{/
  );
  if (mainIndex < 0)
    return null;

  const declarations = String(source).slice(0, mainIndex).trim();
  const braceIndex = String(source).indexOf('{', mainIndex);
  if (braceIndex < 0)
    return null;

  let depth = 0;
  for (let i = braceIndex; i < String(source).length; i++) {
    if (String(source)[i] === '{')
      depth++;
    else if (String(source)[i] === '}') {
      depth--;
      if (depth === 0) {
        return {
          declarations,
          body: String(source).slice(braceIndex + 1, i).trim(),
        };
      }
    }
  }
  return null;
}

function createSnippet(Cogl, source) {
  if (!Cogl?.Snippet?.new)
    return null;

  const parts = splitShaderSource(source);
  if (!parts)
    return null;

  try {
    const snippet = Cogl.Snippet.new(
      Cogl.SnippetHook.FRAGMENT,
      parts.declarations,
      null
    );
    snippet.set_replace(parts.body);
    return snippet;
  } catch (error) {
    logWarning(`nie można utworzyć GLSL snippetu maski: ${error.message}`);
    return null;
  }
}

let loggingGLib = null;

function logWarning(message) {
  try {
    if (loggingGLib?.log_structured) {
      loggingGLib.log_structured(
        'Spotlight',
        loggingGLib.LogLevelFlags.LEVEL_WARNING,
        message
      );
    } else if (typeof printerr === 'function') {
      printerr(`Spotlight: WARNING: ${message}`);
    }
  } catch {
    // Logging must never be the reason the modal stops working.
  }
}

function setFloatUniform(effect, GObject, name, value) {
  if (!GObject?.Value || typeof effect.set_uniform_value !== 'function')
    return;

  const gvalue = new GObject.Value();
  gvalue.init(GObject.TYPE_FLOAT);
  gvalue.set_float(Number(value));
  effect.set_uniform_value(name, gvalue);
}

let maskEffectClass = null;

/**
 * Create (or reuse) the Clutter.ShaderEffect subclass. GObject and Clutter are
 * injected so this module stays importable by the PURE test runner.
 *
 * @param {{GObject: object, Clutter: object, Cogl?: object}} deps
 * @returns {Function|null}
 */
export function getRoundedMaskEffectClass({ GObject, Clutter, Cogl = null, GLib = null } = {}) {
  if (maskEffectClass)
    return maskEffectClass;
  if (GLib)
    loggingGLib = GLib;
  if (typeof GObject?.registerClass !== 'function' ||
      typeof Clutter?.ShaderEffect !== 'function')
    return null;

  const usesSnippet = typeof Clutter.ShaderEffect.new_with_snippet === 'function';
  const legacyShaderSource = !usesSnippet &&
    typeof Clutter.ShaderEffect.prototype?.set_shader_source === 'function';

  const EffectClass = class RoundedMaskEffect extends Clutter.ShaderEffect {
    _init(params = {}) {
      super._init();

      this._radius = 0;
      this._maskWidth = 1;
      this._maskHeight = 1;
      this._compiled = false;
      this._shaderFailure = '';

      if (legacyShaderSource) {
        try {
          this.set_shader_source(ROUNDED_MASK_SHADER);
          // Mutter's shader effect does not throw on a failed compile; it
          // drops the source. Treat a missing source as an unavailable mask so
          // the modal can fall back to the translucent panel.
          this._compiled = Boolean(this.get_shader_source?.());
        } catch (error) {
          this._compiled = false;
          this._shaderFailure = String(error?.message ?? error);
        }
      } else if (usesSnippet) {
        this._compiled = Boolean(Cogl && createSnippet(Cogl, ROUNDED_MASK_SHADER));
        if (!this._compiled)
          this._shaderFailure = 'Cogl.Snippet jest niedostępny';
      } else {
        this._shaderFailure = 'brak API shaderów w Clutter.ShaderEffect';
      }

      if (!this._compiled)
        logWarning(
          `maska zaokrągleń niedostępna: ${this._shaderFailure || 'kompilacja GLSL'}`
        );

      this.setMaskGeometry(
        params.width ?? this._maskWidth,
        params.height ?? this._maskHeight,
        params.radius ?? this._radius
      );
    }

    get compiled() {
      return this._compiled;
    }

    get radius() {
      return this._radius;
    }

    set radius(value) {
      this.setMaskGeometry(this._maskWidth, this._maskHeight, value);
    }

    get maskWidth() {
      return this._maskWidth;
    }

    get maskHeight() {
      return this._maskHeight;
    }

    setMaskGeometry(width, height, radius) {
      const nextWidth = Math.max(1, finiteNumber(width, 1));
      const nextHeight = Math.max(1, finiteNumber(height, 1));
      const nextRadius = clampMaskRadius(radius, nextWidth, nextHeight);

      this._maskWidth = nextWidth;
      this._maskHeight = nextHeight;
      this._radius = nextRadius;

      setFloatUniform(this, GObject, 'radius', nextRadius);
      setFloatUniform(this, GObject, 'width', nextWidth);
      setFloatUniform(this, GObject, 'height', nextHeight);
      try {
        this.queue_repaint?.();
      } catch {
        // The effect may already be detached during teardown.
      }
    }
  };

  if (usesSnippet) {
    Object.defineProperty(EffectClass.prototype, 'vfunc_get_static_snippet', {
      value() {
        return createSnippet(Cogl, ROUNDED_MASK_SHADER);
      },
    });
  }

  maskEffectClass = GObject.registerClass(
    { GTypeName: gtypeName('RoundedMask', import.meta.url) },
    EffectClass
  );
  return maskEffectClass;
}

/**
 * Build a ready-to-attach mask effect.
 *
 * @param {{GObject: object, Clutter: object, Cogl?: object,
 *   width?: number, height?: number, radius?: number}} options
 * @returns {object|null}
 */
export function createRoundedMaskEffect(options = {}) {
  const EffectClass = getRoundedMaskEffectClass(options);
  if (!EffectClass)
    return null;

  try {
    const effect = new EffectClass({
      width: options.width,
      height: options.height,
      radius: options.radius,
    });
    if (effect.compiled === false)
      return null;
    return effect;
  } catch (error) {
    logWarning(`nie można utworzyć maski zaokrągleń: ${error.message}`);
    return null;
  }
}

export default {
  maskCoverage,
  clampMaskRadius,
  createRoundedMaskEffect,
  getRoundedMaskEffectClass,
  ROUNDED_MASK_SHADER,
};