// Progressive edge-blur effect for the scrollable results list.
//
// The geometry math lives in lib/edge-fade.js (PURE, covered by the gjs
// acceptance gate). This module owns the Clutter/Cogl glue: a ShaderEffect
// subclass whose fragment snippet blurs and fades the content toward the top
// and bottom edge of the scroll view. It deliberately fails soft: when the
// Shell build has no usable shader API the effect is not attached and the list
// keeps its current, hard-clipped look.

import { gtypeName } from '../gtype.js';
import {
  EDGE_FADE_SHADER,
  EDGE_FADE_HEIGHT_PX,
  EDGE_FADE_BLUR_PX,
  EDGE_FADE_ALPHA_AT_EDGE,
} from '../edge-fade.js';

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

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
    logWarning(`nie można utworzyć GLSL snippetu edge blur: ${error.message}`);
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
    // Logging must never be the reason the list stops working.
  }
}

function setFloatUniform(effect, GObject, name, value) {
  if (!GObject?.Value || typeof effect.set_uniform_value !== 'function')
    return;
  try {
    const gvalue = new GObject.Value();
    gvalue.init(GObject.TYPE_FLOAT);
    gvalue.set_float(Number(value));
    effect.set_uniform_value(name, gvalue);
  } catch {
    // A uniform that does not exist is not fatal for the effect.
  }
}

let edgeFadeClass = null;

/**
 * Create (or reuse) the Clutter.ShaderEffect subclass.
 *
 * @param {{GObject: object, Clutter: object, Cogl?: object, GLib?: object}}
 *   deps injected so the PURE test runner never imports this file
 * @returns {Function|null}
 */
export function getEdgeFadeEffectClass({ GObject, Clutter, Cogl = null, GLib = null } = {}) {
  if (edgeFadeClass)
    return edgeFadeClass;
  if (GLib)
    loggingGLib = GLib;
  if (typeof GObject?.registerClass !== 'function' ||
      typeof Clutter?.ShaderEffect !== 'function')
    return null;

  const usesSnippet = typeof Clutter.ShaderEffect.new_with_snippet === 'function';
  const legacyShaderSource = !usesSnippet &&
    typeof Clutter.ShaderEffect.prototype?.set_shader_source === 'function';

  const EffectClass = class EdgeFadeEffect extends Clutter.ShaderEffect {
    _init(params = {}) {
      super._init();

      this._fadeWidth = 1;
      this._fadeHeight = 1;
      this._topStrength = 0;
      this._bottomStrength = 0;
      this._fadeHeightPx = finiteNumber(
        params.fadeHeight, EDGE_FADE_HEIGHT_PX
      );
      this._blurPx = finiteNumber(params.blurPx, EDGE_FADE_BLUR_PX);
      this._alphaAtEdge = finiteNumber(
        params.alphaAtEdge, EDGE_FADE_ALPHA_AT_EDGE
      );
      this._compiled = false;

      if (legacyShaderSource) {
        try {
          this.set_shader_source(EDGE_FADE_SHADER);
          this._compiled = Boolean(this.get_shader_source?.());
        } catch (error) {
          this._compiled = false;
          logWarning(
            `edge blur niedostępny (legacy shader): ${error.message}`
          );
        }
      } else if (usesSnippet) {
        this._compiled = Boolean(Cogl && createSnippet(Cogl, EDGE_FADE_SHADER));
        if (!this._compiled)
          logWarning('edge blur niedostępny: Cogl.Snippet jest niedostępny');
      } else {
        logWarning('edge blur niedostępny: brak API shaderów w Clutter.ShaderEffect');
      }

      this.setFadeGeometry(
        params.width ?? 1,
        params.height ?? 1,
        params.topStrength ?? 0,
        params.bottomStrength ?? 0
      );
    }

    get compiled() {
      return this._compiled;
    }

    get fadeWidth() {
      return this._fadeWidth;
    }

    get fadeHeight() {
      return this._fadeHeight;
    }

    get topStrength() {
      return this._topStrength;
    }

    get bottomStrength() {
      return this._bottomStrength;
    }

    setFadeGeometry(width, height, topStrength, bottomStrength) {
      this._fadeWidth = Math.max(1, finiteNumber(width, 1));
      this._fadeHeight = Math.max(1, finiteNumber(height, 1));
      this._topStrength = Math.max(0, Math.min(1,
        finiteNumber(topStrength, 0)));
      this._bottomStrength = Math.max(0, Math.min(1,
        finiteNumber(bottomStrength, 0)));

      setFloatUniform(this, GObject, 'width', this._fadeWidth);
      setFloatUniform(this, GObject, 'height', this._fadeHeight);
      setFloatUniform(this, GObject, 'top_strength', this._topStrength);
      setFloatUniform(this, GObject, 'bottom_strength', this._bottomStrength);
      setFloatUniform(this, GObject, 'fade_height', this._fadeHeightPx);
      setFloatUniform(this, GObject, 'blur_px', this._blurPx);
      setFloatUniform(this, GObject, 'alpha_at_edge', this._alphaAtEdge);
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
        return createSnippet(Cogl, EDGE_FADE_SHADER);
      },
    });
  }

  edgeFadeClass = GObject.registerClass(
    { GTypeName: gtypeName('EdgeFade', import.meta.url) },
    EffectClass
  );
  return edgeFadeClass;
}

/**
 * Build a ready-to-attach edge-blur effect.
 *
 * @param {{GObject: object, Clutter: object, Cogl?: object, GLib?: object,
 *   width?: number, height?: number, topStrength?: number,
 *   bottomStrength?: number, fadeHeight?: number, blurPx?: number,
 *   alphaAtEdge?: number}} options
 * @returns {object|null}
 */
export function createEdgeFadeEffect(options = {}) {
  const EffectClass = getEdgeFadeEffectClass(options);
  if (!EffectClass)
    return null;

  try {
    const effect = new EffectClass(options);
    if (effect.compiled === false)
      return null;
    return effect;
  } catch (error) {
    logWarning(`nie można utworzyć efektu edge blur: ${error.message}`);
    return null;
  }
}

export default {
  createEdgeFadeEffect,
  getEdgeFadeEffectClass,
};
