// Backdrop clone used by the real blur.
//
// Two layers are cloned into one panel-sized actor: the desktop background and
// the window group. The panel itself lives in Main.uiGroup, so cloning
// window_group cannot recurse into our own actor. Main.uiGroup and the stage
// are explicitly rejected, since cloning either would include the panel.

import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import St from 'gi://St';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { gtypeName } from '../gtype.js';
import { createRoundedMaskEffect } from './rounded-mask.js';

let backdropClass = null;

function getBackdropClass() {
  if (backdropClass)
    return backdropClass;

  // BinLayout gives an expanded child the full panel allocation, but it must
  // not contribute its monitor-sized natural size to the panel height.
  backdropClass = GObject.registerClass(
    { GTypeName: gtypeName('BlurBackdrop', import.meta.url) },
    class BlurBackdrop extends St.Widget {
      _init(params = {}) {
        super._init(params);
      }

      vfunc_get_preferred_width() {
        return [0, 0];
      }

      vfunc_get_preferred_height() {
        return [0, 0];
      }
    }
  );
  return backdropClass;
}

function actorSize(actor) {
  if (!actor)
    return { width: 0, height: 0 };

  let width = 0;
  let height = 0;
  try {
    width = Number(actor.get_width?.() ?? actor.width ?? 0);
    height = Number(actor.get_height?.() ?? actor.height ?? 0);
    if ((!Number.isFinite(width) || width <= 0) &&
        typeof actor.get_preferred_width === 'function') {
      width = Number(actor.get_preferred_width(-1)?.[1] ?? width);
    }
    if ((!Number.isFinite(height) || height <= 0) &&
        typeof actor.get_preferred_height === 'function') {
      height = Number(actor.get_preferred_height(-1)?.[1] ?? height);
    }
  } catch {
    width = 0;
    height = 0;
  }

  return {
    width: Number.isFinite(width) && width > 0 ? width : 0,
    height: Number.isFinite(height) && height > 0 ? height : 0,
  };
}

function isAncestorOf(actor, child) {
  let current = child;
  while (current) {
    if (current === actor)
      return true;
    try {
      current = current.get_parent?.() ?? null;
    } catch {
      current = null;
    }
  }
  return false;
}

function safeSource(source, panel) {
  if (!source)
    return null;

  try {
    if (source === Main.uiGroup || source === global.stage)
      return null;
    if (panel && (source === panel || isAncestorOf(source, panel)))
      return null;
  } catch {
    return null;
  }
  return source;
}

/**
 * Resolve the two layers that may be cloned. Main.uiGroup and the stage are
 * never valid sources: cloning them would include the Spotlight panel itself.
 *
 * @param {{layoutManager?: object, windowGroup?: object, panel?: object}} [options]
 * @returns {{background: object|null, windows: object|null}}
 */
export function blurSources(options = {}) {
  const layoutManager = options.layoutManager ?? Main.layoutManager;
  const windowGroup = options.windowGroup ?? global.window_group ?? null;
  const panel = options.panel ?? null;

  return {
    background: safeSource(layoutManager?._backgroundGroup ?? null, panel),
    windows: safeSource(windowGroup, panel),
  };
}

function createBlurEffect(radius) {
  const properties = {
    radius,
    brightness: 1.0,
  };
  if (Shell.BlurMode && Shell.BlurMode.ACTOR !== undefined)
    properties.mode = Shell.BlurMode.ACTOR;
  return new Shell.BlurEffect(properties);
}

function createClone(source, panel) {
  const clone = new Clutter.Clone({
    source,
    reactive: false,
  });
  if (panel && typeof clone.add_constraint === 'function') {
    clone.add_constraint(new Clutter.BindConstraint({
      source: panel,
      coordinate: Clutter.BindCoordinate.SIZE,
    }));
  }
  return clone;
}

/**
 * Build the backdrop actor, its two clones and both effects.
 *
 * @param {{panel: object, style: object, sources?: object}} options
 * @returns {object|null}
 */
export function createPanelBackdrop(options = {}) {
  const panel = options.panel;
  const style = options.style ?? {};
  const sources = options.sources ?? blurSources({ panel });

  if (!panel || !sources.background || !sources.windows)
    return null;

  let blurEffect = null;
  let maskEffect = null;

  try {
    blurEffect = createBlurEffect(style.blurRadius ?? 24);
  } catch (error) {
    GLib.log_structured(
      'Spotlight',
      GLib.LogLevelFlags.LEVEL_WARNING,
      `nie można utworzyć Shell.BlurEffect: ${error.message}`
    );
    return null;
  }

  maskEffect = createRoundedMaskEffect({
    GObject,
    Clutter,
    Cogl,
    GLib,
    width: Math.max(1, Number(panel.width) || 1),
    height: Math.max(1, Number(panel.height) || 1),
    radius: style.radius ?? 18,
  });
  if (!maskEffect) {
    GLib.log_structured(
      'Spotlight',
      GLib.LogLevelFlags.LEVEL_WARNING,
      'maska zaokrągleń jest niedostępna; blur zostaje wyłączony'
    );
    return null;
  }

  let Backdrop = null;
  try {
    Backdrop = getBackdropClass();
  } catch (error) {
    GLib.log_structured(
      'Spotlight',
      GLib.LogLevelFlags.LEVEL_WARNING,
      `nie można zarejestrować kontenera blur: ${error.message}`
    );
    return null;
  }

  // Two nested actors, deliberately:
  //
  //   actor      (masked, rounded)  <- inserted into the panel
  //   ├── blurHost (Shell.BlurEffect over the clones)
  //   └── veil     (readability tint, part of the masked composite)
  //
  // Applying the mask to the SAME actor that carries the blur leaves the
  // effect order up to Clutter: when the blur runs after the mask it samples
  // the panel edge with clamped pixels and spreads panel-coloured squares
  // outside the rounded arc (the reported "angular scraps without blur" in
  // the corners). With the blur on an inner actor and the mask on the outer
  // one, the rounded shape always clips the final composite.
  const actor = new Backdrop({
    style_class: 'spotlight-blur-backdrop',
    x_expand: true,
    y_expand: true,
    reactive: false,
    clip_to_allocation: true,
    layout_manager: new Clutter.FixedLayout(),
  });

  const blurHost = new Backdrop({
    style_class: 'spotlight-blur-clones',
    x_expand: true,
    y_expand: true,
    reactive: false,
    clip_to_allocation: true,
    layout_manager: new Clutter.FixedLayout(),
  });
  blurHost.add_constraint(new Clutter.BindConstraint({
    source: actor,
    coordinate: Clutter.BindCoordinate.SIZE,
  }));
  actor.add_child(blurHost);

  const backgroundClone = createClone(sources.background, panel);
  const windowClone = createClone(sources.windows, panel);
  blurHost.add_child(backgroundClone);
  blurHost.add_child(windowClone);
  blurHost.add_effect(blurEffect);

  // The veil lives *inside* the masked container, above the blurred clones, so
  // the readability tint is clipped by the same rounded shape. It also gets its
  // own mask: set_style() only changes the colour, so a later stylesheet or
  // inline update must never turn the veil back into an unmasked rectangle.
  const veil = new Backdrop({
    style_class: 'spotlight-blur-veil',
    x_expand: true,
    y_expand: true,
    reactive: false,
    clip_to_allocation: true,
  });
  veil.add_constraint(new Clutter.BindConstraint({
    source: actor,
    coordinate: Clutter.BindCoordinate.SIZE,
  }));
  actor.add_child(veil);

  const veilMaskEffect = createRoundedMaskEffect({
    GObject,
    Clutter,
    Cogl,
    GLib,
    width: Math.max(1, Number(panel.width) || 1),
    height: Math.max(1, Number(panel.height) || 1),
    radius: style.radius ?? 18,
  });
  if (veilMaskEffect)
    veil.add_effect(veilMaskEffect);

  actor.add_effect(maskEffect);

  return {
    actor,
    blurHost,
    layer: actor,
    blurEffect,
    maskEffect,
    veil,
    veilMaskEffect,
    backgroundClone,
    windowClone,
    clones: [backgroundClone, windowClone],
    sources,
  };
}

/**
 * Recompute clone offsets/scales and the mask geometry after open/resize.
 *
 * A Clutter.Clone scales its source to its own allocation. Binding the clone
 * to the panel keeps layout stable; the compensating actor scale restores the
 * source pixels 1:1 and the negative panel origin selects the area behind the
 * panel.
 *
 * @param {object} backdrop
 * @param {{panelX?: number, panelY?: number, width?: number, height?: number,
 *   radius?: number}} [geometry]
 */
export function updatePanelBackdropGeometry(backdrop, geometry = {}) {
  if (!backdrop?.actor)
    return;

  const width = Math.max(1, Number(geometry.width) || Number(backdrop.actor.width) || 1);
  const height = Math.max(1, Number(geometry.height) || Number(backdrop.actor.height) || 1);
  const panelX = Number.isFinite(Number(geometry.panelX))
    ? Number(geometry.panelX)
    : 0;
  const panelY = Number.isFinite(Number(geometry.panelY))
    ? Number(geometry.panelY)
    : 0;

  for (const clone of backdrop.clones ?? []) {
    const source = clone?.source ?? null;
    const sourceSize = actorSize(source);
    const scaleX = sourceSize.width > 0 ? sourceSize.width / width : 1;
    const scaleY = sourceSize.height > 0 ? sourceSize.height / height : 1;

    try {
      clone.set_position(-panelX, -panelY);
      clone.set_pivot_point(0, 0);
      clone.set_scale(scaleX, scaleY);
    } catch {
      // A source can disappear between two monitor changes.
    }
  }

  const radius = geometry.radius ?? 18;
  const masks = [
    backdrop.maskEffect,
    backdrop.veilMaskEffect,
    ...(Array.isArray(backdrop.maskEffects) ? backdrop.maskEffects : []),
  ];
  const updated = new Set();
  for (const mask of masks) {
    if (!mask || updated.has(mask))
      continue;
    updated.add(mask);
    try {
      mask.setMaskGeometry?.(width, height, radius);
    } catch (error) {
      GLib.log_structured(
        'Spotlight',
        GLib.LogLevelFlags.LEVEL_WARNING,
        `nie można zaktualizować maski zaokrągleń: ${error.message}`
      );
    }
  }
}

export default {
  blurSources,
  createPanelBackdrop,
  updatePanelBackdropGeometry,
};