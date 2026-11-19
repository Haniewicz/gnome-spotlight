// Backdrop clone used by the real blur.
//
// Two layers are cloned into one panel-sized actor: the desktop background and
// the window group. The panel itself lives in Main.uiGroup, so cloning
// window_group cannot recurse into our own actor. Main.uiGroup and the stage
// are explicitly rejected, since cloning either would include the panel.
//
// The blur itself is delegated to Blur my Shell's DualKawaseBlurEffect. That
// effect blurs AND rounds the corners in one pass (corner_radius) with its own
// UV control: its output shader knows the padded blur bounds and cuts the
// rounded silhouette against the actor's surface bounds.
//
// Why the previous architecture is retired: Shell.BlurEffect on a child actor
// expands the ancestor's offscreen paint volume by the blur padding, while our
// Clutter.ShaderEffect mask computed its rounded rectangle from the *actor*
// size only. That mismatch left a sharp square scrap of blurred backdrop in
// each corner (reported as "broken corners" in blur mode). A second rounded
// mask on the tint layer only made the two arcs disagree further. When Blur my
// Shell is not installed/enabled the blur is disabled and the panel falls back
// to its semi-transparent CSS background instead of painting broken corners.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { gtypeName } from '../gtype.js';

const BMS_UUID = 'blur-my-shell@aunetx';
const BMS_BLUR_PATH = 'effects/blur/dual_kawase_blur.js';

let bmsBlurClass = null;
let bmsLoadPromise = null;

/**
 * Load Blur my Shell's blur effect class once (idempotent). The import is a
 * local file read, so it resolves quickly; call it at extension enable and the
 * class is cached before the panel is first opened.
 *
 * @returns {Promise<Function|null>} the DualKawaseBlurEffect class, or null
 */
export function initBmsBlur() {
  if (!bmsLoadPromise) {
    bmsLoadPromise = (async () => {
      try {
        const ext = Main.extensionManager.lookup(BMS_UUID);
        if (!ext || !ext.dir)
          return null;
        const file = ext.dir.get_child(BMS_BLUR_PATH);
        const mod = await import(`file://${file.get_path()}`);
        bmsBlurClass = mod.DualKawaseBlurEffect ?? null;
      } catch (error) {
        bmsBlurClass = null;
        GLib.log_structured(
          'Spotlight',
          GLib.LogLevelFlags.LEVEL_DEBUG,
          `Blur my Shell niedostępny, blur wyłączony: ${error.message}`
        );
      }
      return bmsBlurClass;
    })();
  }
  return bmsLoadPromise;
}

/**
 * Whether the BMS blur can be used right now: the class is loaded and the
 * extension is enabled (stateObj is only present while enabled).
 *
 * @returns {boolean}
 */
export function bmsBlurAvailable() {
  if (!bmsBlurClass)
    return false;
  try {
    const ext = Main.extensionManager.lookup(BMS_UUID);
    return Boolean(ext && ext.stateObj);
  } catch {
    return false;
  }
}

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
 * Build the backdrop actor, its two clones and the BMS blur effect.
 *
 * Returns null when the blur cannot be used (no sources, or Blur my Shell not
 * installed/enabled); the caller then keeps the semi-transparent CSS panel.
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

  if (!bmsBlurAvailable())
    return null;

  const radius = style.radius ?? 18;
  let blurEffect = null;
  try {
    blurEffect = new bmsBlurClass({
      unscaled_radius: style.blurRadius ?? 24,
      brightness: 1.0,
    });
    // One effect blurs and rounds; no separate mask is needed.
    blurEffect.corner_radius = radius;
    blurEffect.corners_top = true;
    blurEffect.corners_bottom = true;
  } catch (error) {
    GLib.log_structured(
      'Spotlight',
      GLib.LogLevelFlags.LEVEL_WARNING,
      `nie można utworzyć efektu blur Blur my Shell: ${error.message}`
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

  // Two nested actors:
  //
  //   actor      (panel-sized container)  <- inserted into the panel
  //   ├── blurHost (BMS blur over the clones, rounds its own corners)
  //   └── veil     (readability tint, rounded to the same radius via CSS)
  //
  // The BMS effect rounds the blurred composite itself, so there is no outer
  // mask to race with the blur. The veil is a plain tint rounded by the same
  // border-radius, kept subtle so it cannot leave a visible second edge.
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

  return {
    actor,
    blurHost,
    layer: actor,
    blurEffect,
    // Kept (always null) so the modal/tests can keep the historical shape of
    // the backdrop record; the BMS effect rounds the corners by itself.
    maskEffect: null,
    veil,
    veilMaskEffect: null,
    backgroundClone,
    windowClone,
    clones: [backgroundClone, windowClone],
    sources,
    radius,
  };
}

/**
 * Recompute clone offsets/scales and the blur corner radius after open/resize.
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

  // The BMS blur rounds its own corners; keep the radius in sync with the
  // panel allocation (it can change between compact and expanded views).
  const radius = geometry.radius ?? 18;
  const blur = backdrop.blurEffect;
  if (blur) {
    try {
      blur.corner_radius = radius;
    } catch (error) {
      GLib.log_structured(
        'Spotlight',
        GLib.LogLevelFlags.LEVEL_WARNING,
        `nie można zaktualizować promienia rogów blur: ${error.message}`
      );
    }
  }
}

export default {
  blurSources,
  createPanelBackdrop,
  updatePanelBackdropGeometry,
  initBmsBlur,
  bmsBlurAvailable,
};
