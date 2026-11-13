import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Shell from 'gi://Shell';
import Clutter from 'gi://Clutter';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import { gtypeName } from '../gtype.js';
import { SpotlightResultRow } from './resultRow.js';
import { buildActionMenu, createPopupActionMenu } from './actions.js';
import { buildPreviewModel, createPreviewPanel } from './preview.js';
import { parseActions, runAction } from '../action-runner.js';
import {
  resolvePanelStyle,
  resolveBlurVeilAlpha,
  clampPanelOpacity,
  PANEL_RGB,
  DEFAULT_PANEL_OPACITY,
  DEFAULT_BLUR_RADIUS,
  PANEL_RADIUS,
} from '../panel-style.js';
import { planPanelBlur } from '../panel-blur.js';
import {
  blurSources,
  createPanelBackdrop,
  updatePanelBackdropGeometry,
} from './backdrop.js';
import {
  BUS_NAME as DAEMON_BUS_NAME,
  OBJECT_PATH as DAEMON_OBJECT_PATH,
  SEARCH_INTERFACE as DAEMON_SEARCH_INTERFACE,
} from '../daemonClient.js';
import {
  cacheKey,
  lookup,
  remember,
  stabilize,
} from '../searchStream.js';

const PANEL_WIDTH = 860;
const TOP_RATIO = 0.14;
const SEARCH_DEBOUNCE_MS = 120;
const DEFAULT_RESULT_LIMIT = 10;

// The result list may use at most 60% of the monitor height, minus a small
// breathing margin. The remaining panel chrome (search row, footer, borders)
// is reserved so the modal never grows past the work area.
const RESULTS_MAX_HEIGHT_RATIO = 0.6;
const RESULTS_HEIGHT_MARGIN = 32;
const RESULTS_PANEL_RESERVE = 120;
const RESULTS_SCROLL_MARGIN = 4;
const RESULTS_WHEEL_STEP = 48;
const BLUR_PANEL_MAX_OPACITY = 0.85;

// Field prefixes that select a daemon mode instead of a plain query. The
// trailing space is part of the prefix; the bare word is accepted as soon as
// the user has typed it so the footer can announce the mode immediately.
const QUERY_MODE_PREFIXES = Object.freeze([
  ['ssh', 'ssh '],
  ['sys', 'sys '],
  ['snip', 'snip '],
  ['docker', 'docker '],
]);

function queryMode(query) {
  const text = String(query ?? '').trim().toLowerCase();
  for (const [mode, prefix] of QUERY_MODE_PREFIXES) {
    if (text === prefix.trim() || text.startsWith(prefix))
      return mode;
  }
  return '';
}

function resultIdentity(result) {
  const providerId = result?.providerId ?? '';
  const id = result?.id;
  return `${providerId}\u0000${id === undefined || id === null ? '' : String(id)}`;
}

function spawnArgv(argv) {
  const launcher = new Gio.SubprocessLauncher({
    flags: Gio.SubprocessFlags.NONE,
  });
  launcher.spawnv(argv.map(value => String(value)));
  return true;
}

function daemonCall(method, ...args) {
  return new Promise(resolve => {
    let connection = null;
    try {
      connection = Gio.DBus.session;
    } catch {
      connection = null;
    }
    if (!connection) {
      resolve(false);
      return;
    }

    try {
      connection.call(
        DAEMON_BUS_NAME,
        DAEMON_OBJECT_PATH,
        DAEMON_SEARCH_INTERFACE,
        String(method),
        new GLib.Variant('(s)', args.map(value => String(value))),
        new GLib.VariantType('(b)'),
        Gio.DBusCallFlags.NONE,
        1000,
        null,
        (source, result) => {
          try {
            const reply = source.call_finish(result);
            resolve(Boolean(reply.deep_unpack()[0]));
          } catch {
            resolve(false);
          }
        }
      );
    } catch {
      resolve(false);
    }
  });
}

function createActionDeps() {
  return {
    St,
    Shell,
    Gio,
    GLib,
    Main,
    spawn: spawnArgv,
    daemonCall,
  };
}

/**
 * Spotlight launcher modal. extension.js supplies options.registry; typing
 * runs a debounced registry.search() and feeds the grouped results back
 * through setResults().
 */
export const SpotlightModal = GObject.registerClass(
  { GTypeName: gtypeName('Modal', import.meta.url) },
  class SpotlightModal extends St.BoxLayout {
    _init(settings = null, options = {}) {
      super._init({
        style_class: 'spotlight-modal',
        orientation: Clutter.Orientation.VERTICAL,
        reactive: true,
        can_focus: false,
        visible: false,
      });

      this.set_width(PANEL_WIDTH);

      this._settings = settings;
      this._options = options ?? {};
      this._isOpen = false;
      this._destroyed = false;
      this._grab = null;
      this._rows = [];
      this._sections = [];
      this._sectionBoxes = [];
      this._rowPool = [];
      this._rowKeys = [];
      this._iconCache = new Map();
      this._selectedIndex = -1;
      this._query = '';
      this._compact = true;
      this._capturedId = 0;
      this._textChangedId = 0;
      this._searchTimer = 0;
      this._searchToken = 0;
      this._previewToken = 0;
      this._previewVisible = false;
      this._previewMode = false;
      this._previewResultKey = '';
      this._resultsScroll = null;
      this._panelBlurActor = null;
      this._panelBlurContainer = null;
      this._panelBlurLayer = null;
      this._panelBlurClone = null;
      this._panelBlurWindowClone = null;
      this._panelBlurEffect = null;
      this._panelBlurMask = null;
      this._panelBlurVeil = null;
      this._panelBlurSource = null;
      this._panelBlurUnavailable = false;
      this._panelBlurRadius = PANEL_RADIUS;
      this._panelSizeChangedIds = [];
      this._styleChangedIds = [];
      this._previewEnabledChangedId = 0;
      this._monitorsChangedId = 0;
      this._modalStyle = null;
      this._actionMenu = null;
      this._menuManager = null;
      this._lastResults = [];
      this._configuredMode = String(options?.mode ?? '');
      this._footer = null;
      this._footerMode = null;
      this._footerSource = null;
      this._actionDepsValue = null;

      this._buildUI();
      this._applyPanelStyle();
      this._connectStyleSettings();

      this._capturedId = this.connect(
        'captured-event',
        this._onCapturedEvent.bind(this)
      );
    }

    _buildUI() {
      // A BinLayout lets the optional blur backdrop sit *behind* the normal
      // vertical content without taking part in its size negotiation.
      this._panel = new St.Widget({
        x_expand: true,
        y_expand: true,
        layout_manager: new Clutter.BinLayout(),
      });
      this.add_child(this._panel);

      // The mask radius and clone geometry follow the allocated panel size,
      // not only open(): animations, preview toggles and monitor changes can
      // resize the panel while it stays open.
      for (const signal of ['notify::width', 'notify::height']) {
        try {
          this._panelSizeChangedIds.push(this._panel.connect(
            signal,
            () => this._updatePanelBlurGeometry()
          ));
        } catch (error) {
          logError(error);
        }
      }

      this._panelContent = new St.BoxLayout({
        orientation: Clutter.Orientation.VERTICAL,
        x_expand: true,
        y_expand: true,
      });
      this._panel.add_child(this._panelContent);

      const searchRow = new St.BoxLayout({
        style_class: 'spotlight-search-row',
      });
      this._panelContent.add_child(searchRow);

      searchRow.add_child(new St.Icon({
        icon_name: 'system-search-symbolic',
        style_class: 'spotlight-search-icon',
        icon_size: 21,
      }));

      this._entry = new St.Entry({
        style_class: 'spotlight-entry',
        can_focus: true,
        reactive: true,
        x_expand: true,
        hint_text: 'Szukaj…',
      });
      searchRow.add_child(this._entry);

      this._textChangedId = this._entry.clutter_text.connect(
        'text-changed',
        () => this._onTextChanged()
      );

      this._body = new St.BoxLayout({
        style_class: 'spotlight-body',
        x_expand: true,
      });
      this._body.visible = false;
      this._panelContent.add_child(this._body);

      this._results = new St.BoxLayout({
        style_class: 'spotlight-results',
        orientation: Clutter.Orientation.VERTICAL,
        x_expand: true,
      });

      // The list is the only vertically scrollable part of the modal. Keeping
      // the search row and footer outside the viewport means they stay put
      // while the wheel/arrow keys move through the results.
      const scrollProperties = {
        style_class: 'spotlight-results-scroll',
        x_expand: true,
        reactive: true,
        hscrollbar_policy: St.PolicyType.NEVER,
        vscrollbar_policy: St.PolicyType.AUTOMATIC,
        enable_mouse_scrolling: true,
      };
      // St 51 calls this overlay-scrollbars; older builds exposed
      // overlay-scrolling. Only pass the property the installed St provides.
      if ('overlay_scrollbars' in St.ScrollView.prototype)
        scrollProperties.overlay_scrollbars = false;
      else
        scrollProperties.overlay_scrolling = false;
      this._resultsScroll = new St.ScrollView(scrollProperties);
      this._resultsScroll.connect(
        'scroll-event',
        (actor, event) => this._onResultsScroll(actor, event)
      );
      this._body.add_child(this._resultsScroll);
      if (typeof this._resultsScroll.set_child === 'function')
        this._resultsScroll.set_child(this._results);
      else
        this._resultsScroll.add_child(this._results);

      // 860/296 split from DESIGN §7; the panel hides itself when the
      // preview setting is off or the selected result has no preview.
      this._preview = createPreviewPanel(St, GObject, Clutter);
      this._body.add_child(this._preview);

      this._empty = new St.BoxLayout({
        style_class: 'spotlight-empty',
        orientation: Clutter.Orientation.VERTICAL,
        x_expand: true,
        y_expand: true,
        x_align: Clutter.ActorAlign.CENTER,
        y_align: Clutter.ActorAlign.CENTER,
      });
      this._empty.add_child(new St.Icon({
        icon_name: 'system-search-symbolic',
        style_class: 'spotlight-empty-icon',
        icon_size: 42,
      }));
      this._emptyTitle = new St.Label({
        style_class: 'spotlight-empty-title',
        text: 'Zacznij pisać',
      });
      this._empty.add_child(this._emptyTitle);
      this._emptyHint = new St.Label({
        style_class: 'spotlight-empty-hint',
        text: 'Wpisz nazwę aplikacji, pliku lub komendę',
      });
      this._empty.add_child(this._emptyHint);
      this._results.add_child(this._empty);

      this._footer = new St.BoxLayout({
        style_class: 'spotlight-footer',
      });
      this._footer.visible = false;
      this._panelContent.add_child(this._footer);
      this._footer.add_child(new St.Label({
        style_class: 'spotlight-footer-hints',
        text: '↑↓ wybór   ⏎ otwórz   Ctrl+Space podgląd   Tab sekcje   Esc zamknij',
        x_expand: true,
      }));
      this._footerMode = new St.Label({
        style_class: 'spotlight-footer-mode',
        text: '',
      });
      this._footer.add_child(this._footerMode);

      // The source stays available to the perf/smoke instrumentation but is
      // deliberately not part of the visible footer anymore.
      this._footerSource = {
        _text: 'offline',
        visible: false,
        get_text() {
          return this._text;
        },
        set_text(value) {
          this._text = String(value ?? '');
        },
      };
    }

    _panelSetting(getter, fallback) {
      if (!this._settings)
        return fallback;
      try {
        const value = getter(this._settings);
        return value === undefined || value === null ? fallback : value;
      } catch {
        return fallback;
      }
    }

    _readPanelStyle() {
      const opacity = this._panelSetting(
        settings => settings.get_double('panel-opacity'),
        DEFAULT_PANEL_OPACITY
      );
      return {
        opacity: clampPanelOpacity(opacity),
        style: resolvePanelStyle({
          opacity,
          blurEnabled: this._panelSetting(
            settings => settings.get_boolean('blur-enabled'),
            false
          ),
          blurRadius: this._panelSetting(
            settings => settings.get_int('blur-radius'),
            DEFAULT_BLUR_RADIUS
          ),
        }),
        veilAlpha: resolveBlurVeilAlpha(opacity),
      };
    }

    _applyPanelStyle() {
      if (this._destroyed)
        return;

      const { opacity, style, veilAlpha } = this._readPanelStyle();
      this._modalStyle = style;

      const blurActive = this._syncPanelBlur(style, veilAlpha);

      // Inline background wins over the stylesheet default while leaving the
      // border, radius and shadow from .spotlight-modal untouched. A fully
      // opaque panel would hide the cloned backdrop, so the veil/panel pair
      // keeps a little transparency while the clone is alive.
      const background = blurActive
        ? this._blurPanelBackground(opacity)
        : style.background;
      this.set_style(`background-color: ${background};`);
    }

    _blurPanelBackground(opacity) {
      const alpha = Math.min(opacity, BLUR_PANEL_MAX_OPACITY);
      return `rgba(${PANEL_RGB},${Number(alpha.toFixed(3))})`;
    }

    _backgroundGroup() {
      try {
        return Main.layoutManager?._backgroundGroup ?? null;
      } catch {
        return null;
      }
    }

    _blurSources() {
      try {
        return blurSources({
          layoutManager: Main.layoutManager,
          windowGroup: global.window_group ?? null,
          panel: this._panel,
        });
      } catch {
        return { background: null, windows: null };
      }
    }

    /**
     * Radius comes from the themed .spotlight-modal CSS (18 px), with the
     * PANEL_RADIUS constant as a safe fallback in headless/early layout.
     */
    _panelRadius() {
      let radius = PANEL_RADIUS;
      try {
        const node = this.get_theme_node?.() ??
          this._panel?.get_theme_node?.();
        const value = node?.get_border_radius?.(St.Corner.TOPLEFT);
        const candidate = Array.isArray(value)
          ? Number(value[0])
          : Number(value);
        if (Number.isFinite(candidate) && candidate > 0)
          radius = candidate;
      } catch {
        // Theme nodes are unavailable before the actor reaches the stage.
      }
      return Math.max(0, Math.round(radius));
    }

    _panelPosition() {
      // The panel is parented through Main.uiGroup, so its transformed
      // position is the screen origin that the screen-space clones need.
      try {
        const [x, y] = this._panel?.get_transformed_position?.() ?? [];
        if (Number.isFinite(Number(x)) && Number.isFinite(Number(y)))
          return { x: Number(x), y: Number(y) };
      } catch {
        // Fall through to the modal's own position before it is mapped.
      }

      return {
        x: Number.isFinite(Number(this.x)) ? Number(this.x) : 0,
        y: Number.isFinite(Number(this.y)) ? Number(this.y) : 0,
      };
    }

    _setCloneSource(clone, source) {
      if (!clone || !source || clone.source === source)
        return;
      try {
        clone.set_source(source);
      } catch {
        try {
          clone.source = source;
        } catch (error) {
          logError(error);
        }
      }
    }

    _createPanelBlur(style, sources) {
      const radius = this._panelRadius();
      const backdrop = createPanelBackdrop({
        panel: this._panel,
        style: { ...style, radius },
        sources,
      });
      if (!backdrop)
        return false;

      // First child in the panel's BinLayout: it paints behind the content,
      // fills the panel allocation and reports zero natural size. The veil is
      // a sibling directly above it, still behind the normal panel content.
      this._panel.insert_child_at_index(backdrop.actor, 0);
      if (backdrop.veil)
        this._panel.insert_child_at_index(backdrop.veil, 1);

      this._panelBlurActor = backdrop.actor;
      this._panelBlurLayer = backdrop.layer;
      this._panelBlurContainer = backdrop.actor;
      this._panelBlurClone = backdrop.backgroundClone;
      this._panelBlurWindowClone = backdrop.windowClone;
      this._panelBlurEffect = backdrop.blurEffect;
      this._panelBlurMask = backdrop.maskEffect;
      this._panelBlurVeil = backdrop.veil;
      this._panelBlurSource = sources.background;
      this._panelBlurRadius = radius;
      return true;
    }

    _updatePanelBlurGeometry(sources = null) {
      if (!this._panelBlurActor || !this._panelBlurClone)
        return;

      const nextSources = sources ?? this._blurSources();
      if (nextSources.background) {
        this._setCloneSource(this._panelBlurClone, nextSources.background);
        this._panelBlurSource = nextSources.background;
      }
      if (nextSources.windows)
        this._setCloneSource(this._panelBlurWindowClone, nextSources.windows);

      const position = this._panelPosition();
      const width = Math.max(1, Number(this._panel?.width) || 1);
      const height = Math.max(1, Number(this._panel?.height) || 1);
      const radius = this._panelRadius();
      this._panelBlurRadius = radius;

      updatePanelBackdropGeometry({
        actor: this._panelBlurActor,
        clones: [this._panelBlurClone, this._panelBlurWindowClone]
          .filter(Boolean),
        maskEffect: this._panelBlurMask,
      }, {
        panelX: position.x,
        panelY: position.y,
        width,
        height,
        radius,
      });
    }

    _syncPanelBlur(style, veilAlpha) {
      if (!style?.requiresBlur) {
        this._panelBlurUnavailable = false;
        this._removePanelBlur();
        return false;
      }

      const sources = this._blurSources();
      const plan = planPanelBlur({
        enabled: true,
        available: typeof Shell.BlurEffect === 'function' &&
          Boolean(sources.background) &&
          Boolean(sources.windows),
        radius: style.blurRadius,
      });

      if (!plan.clone) {
        // Keep the ordinary semi-transparent panel instead of attaching an
        // effect to an empty or incomplete actor tree.
        this._panelBlurUnavailable = true;
        this._removePanelBlur();
        return false;
      }

      this._panelBlurUnavailable = false;
      if (!this._panelBlurActor) {
        if (!this._createPanelBlur(style, sources)) {
          this._panelBlurUnavailable = true;
          this._removePanelBlur();
          return false;
        }
      } else {
        this._setCloneSource(this._panelBlurClone, sources.background);
        this._setCloneSource(this._panelBlurWindowClone, sources.windows);
      }

      this._updatePanelBlurGeometry(sources);

      if (this._panelBlurEffect)
        this._panelBlurEffect.radius = style.blurRadius;
      if (this._panelBlurVeil) {
        this._panelBlurVeil.set_style(
          `background-color: rgba(0,0,0,${veilAlpha});`
        );
      }
      this._panelBlurActor?.show();
      return true;
    }

    _removePanelBlur() {
      const actor = this._panelBlurActor;
      const layer = this._panelBlurLayer;
      const veil = this._panelBlurVeil;

      this._panelBlurActor = null;
      this._panelBlurContainer = null;
      this._panelBlurLayer = null;
      this._panelBlurClone = null;
      this._panelBlurWindowClone = null;
      this._panelBlurEffect = null;
      this._panelBlurMask = null;
      this._panelBlurVeil = null;
      this._panelBlurSource = null;

      if (layer && typeof layer.get_effects === 'function') {
        try {
          for (const effect of [...layer.get_effects()])
            layer.remove_effect(effect);
        } catch (error) {
          logError(error);
        }
      }

      for (const child of [veil, actor]) {
        if (!child)
          continue;
        const parent = child.get_parent();
        if (parent)
          parent.remove_child(child);
        try {
          child.destroy();
        } catch (error) {
          logError(error);
        }
      }
    }

    _connectStyleSettings() {
      if (!this._settings)
        return;

      const connect = (signal, callback) => {
        try {
          this._styleChangedIds.push(this._settings.connect(signal, callback));
        } catch (error) {
          logError(error);
        }
      };

      const apply = () => this._applyPanelStyle();
      connect('changed::panel-opacity', apply);
      connect('changed::blur-enabled', apply);
      connect('changed::blur-radius', apply);

      try {
        this._previewEnabledChangedId = this._settings.connect(
          'changed::preview-enabled',
          () => {
            if (this._previewEnabled())
              return;
            this._hidePreview();
          }
        );
      } catch (error) {
        logError(error);
      }

      try {
        this._monitorsChangedId = Main.layoutManager?.connect(
          'monitors-changed',
          () => {
            if (this._destroyed)
              return;
            this._applyPanelStyle();
            this._syncResultsScrollHeight();
          }
        ) ?? 0;
      } catch (error) {
        this._monitorsChangedId = 0;
        logError(error);
      }
    }

    _disconnectStyleSettings() {
      if (this._settings) {
        for (const id of this._styleChangedIds) {
          try {
            this._settings.disconnect(id);
          } catch (error) {
            logError(error);
          }
        }
        if (this._previewEnabledChangedId) {
          try {
            this._settings.disconnect(this._previewEnabledChangedId);
          } catch (error) {
            logError(error);
          }
        }
      }
      this._styleChangedIds = [];
      this._previewEnabledChangedId = 0;
      if (this._monitorsChangedId) {
        try {
          Main.layoutManager?.disconnect(this._monitorsChangedId);
        } catch (error) {
          logError(error);
        }
        this._monitorsChangedId = 0;
      }
    }

    _setCompact(compact) {
      this._compact = Boolean(compact);
      if (this._body)
        this._body.visible = !this._compact;
      if (this._footer)
        this._footer.visible = !this._compact;
      this._syncResultsScrollHeight();
    }

    _getMonitorIndex() {
      const layoutManager = Main.layoutManager;
      const monitor = this._getMonitor();
      if (Number.isInteger(monitor?.index))
        return monitor.index;

      const monitors = layoutManager?.monitors;
      if (Array.isArray(monitors)) {
        const index = monitors.indexOf(monitor);
        if (index >= 0)
          return index;
      }
      if (Number.isInteger(layoutManager?.currentMonitorIndex))
        return layoutManager.currentMonitorIndex;
      return 0;
    }

    _getWorkArea() {
      const layoutManager = Main.layoutManager;
      const index = this._getMonitorIndex();
      try {
        const area = layoutManager?.getWorkAreaForMonitor?.(index);
        if (
          area &&
          Number.isFinite(area.x) &&
          Number.isFinite(area.y) &&
          Number.isFinite(area.width) &&
          Number.isFinite(area.height) &&
          area.width > 0 &&
          area.height > 0
        ) {
          return area;
        }
      } catch {
        // Fall back to the monitor rectangle below.
      }

      const monitor = this._getMonitor() ?? this._fallbackMonitor();
      return {
        x: Number(monitor.x) || 0,
        y: Number(monitor.y) || 0,
        width: Number(monitor.width) || PANEL_WIDTH,
        height: Number(monitor.height) || 1080,
      };
    }

    _resultsAdjustment() {
      const scroll = this._resultsScroll;
      if (!scroll)
        return null;
      try {
        return scroll.vadjustment ?? scroll.get_vadjustment?.() ?? null;
      } catch {
        return null;
      }
    }

    _syncResultsScrollHeight({ reset = false } = {}) {
      if (this._destroyed || !this._resultsScroll)
        return;

      const monitor = this._getMonitor() ?? this._fallbackMonitor();
      const workArea = this._getWorkArea();
      const ratioLimit =
        Math.floor(monitor.height * RESULTS_MAX_HEIGHT_RATIO) -
        RESULTS_HEIGHT_MARGIN;
      const panelTop = this._isOpen
        ? (Number(this.y) || workArea.y)
        : workArea.y + Math.floor(monitor.height * TOP_RATIO);
      const workAreaLimit =
        workArea.y + workArea.height - panelTop - RESULTS_PANEL_RESERVE;
      const maxHeight = Math.max(
        1,
        Math.min(ratioLimit, workAreaLimit)
      );

      let naturalHeight = 0;
      try {
        naturalHeight = this._results.get_preferred_height(-1)[1];
      } catch {
        naturalHeight = 0;
      }

      const height = Math.max(
        0,
        Math.min(Math.floor(naturalHeight), maxHeight)
      );
      this._resultsScroll.set_height(height);

      const adjustment = this._resultsAdjustment();
      if (!adjustment)
        return;

      if (reset) {
        adjustment.value = 0;
        return;
      }

      const maxValue = Math.max(0, adjustment.upper - adjustment.page_size);
      if (adjustment.value > maxValue)
        adjustment.value = maxValue;
    }

    _getPosition(actor) {
      try {
        return actor.get_transformed_position();
      } catch {
        return [0, 0];
      }
    }

    /**
     * Offset of `row` in the scrollable content space.
     *
     * Clutter layouts allocate children without updating their fixed position,
     * so `row.y` stays 0 for every row inside a box layout — summing `y` up the
     * parent chain always returned 0 and the scroll-into-view logic never moved
     * the adjustment. World coordinates do carry the allocation, and they also
     * include the current scroll offset, so it is added back to keep the result
     * independent from the scroll position.
     */
    _rowOffset(row) {
      const scroll = this._resultsScroll;
      const adjustment = this._resultsAdjustment();
      if (!row || !scroll || !adjustment)
        return 0;

      const [, rowY] = this._getPosition(row);
      const [, viewY] = this._getPosition(scroll);
      const delta = Number(rowY) - Number(viewY);
      if (!Number.isFinite(delta))
        return 0;

      const offset = (Number(adjustment.value) || 0) + delta;
      return Number.isFinite(offset) ? offset : 0;
    }

    _scrollSelectedIntoView() {
      const row = this._selectedRow();
      const adjustment = this._resultsAdjustment();
      if (!row || !adjustment)
        return;

      const value = Number(adjustment.value) || 0;
      const pageSize = Number(adjustment.page_size) || 0;
      if (pageSize <= 0)
        return;

      let rowHeight = Number(row.height) || 0;
      if (rowHeight <= 0) {
        try {
          rowHeight = row.get_preferred_height(-1)[1];
        } catch {
          rowHeight = 0;
        }
      }

      const offset = this._rowOffset(row);
      if (!Number.isFinite(offset))
        return;

      const fullyVisible =
        offset >= value + RESULTS_SCROLL_MARGIN &&
        offset + rowHeight <= value + pageSize - RESULTS_SCROLL_MARGIN;
      if (fullyVisible)
        return;

      const maxValue = Math.max(
        0,
        Number(adjustment.upper) - pageSize
      );
      if (offset < value + RESULTS_SCROLL_MARGIN) {
        adjustment.value = Math.max(
          0,
          Math.min(maxValue, offset - RESULTS_SCROLL_MARGIN)
        );
      } else {
        adjustment.value = Math.min(
          maxValue,
          offset + rowHeight - pageSize + RESULTS_SCROLL_MARGIN
        );
      }
    }

    _onResultsScroll(_actor, event) {
      const adjustment = this._resultsAdjustment();
      if (!adjustment)
        return Clutter.EVENT_PROPAGATE;

      const direction = event?.get_scroll_direction?.() ??
        Clutter.ScrollDirection.NONE;
      let delta = 0;
      if (direction === Clutter.ScrollDirection.UP) {
        delta = -RESULTS_WHEEL_STEP;
      } else if (direction === Clutter.ScrollDirection.DOWN) {
        delta = RESULTS_WHEEL_STEP;
      } else if (direction === Clutter.ScrollDirection.SMOOTH) {
        const scrollDelta = event?.get_scroll_delta?.() ?? [0, 0];
        delta = Number(scrollDelta?.[1] ?? 0);
      }

      if (delta === 0)
        return Clutter.EVENT_PROPAGATE;

      const maxValue = Math.max(
        0,
        Number(adjustment.upper) - Number(adjustment.page_size)
      );
      const next = Math.max(
        0,
        Math.min(maxValue, Number(adjustment.value) + delta)
      );
      adjustment.value = next;
      return Clutter.EVENT_STOP;
    }

    _resultLimit() {
      const configured = this._options?.limit ?? this._options?.maxResults;
      const value = Number(configured);
      if (Number.isFinite(value) && value >= 0)
        return Math.floor(value);
      return DEFAULT_RESULT_LIMIT;
    }

    _iconProps(result) {
      const iconValue = result?.icon;
      const props = {
        style_class: 'spotlight-row-icon',
        icon_size: 24,
      };
      if (typeof iconValue === 'string')
        props.icon_name = iconValue;
      else if (iconValue)
        props.gicon = iconValue;
      else
        props.icon_name = 'application-x-executable-symbolic';
      return props;
    }

    _iconFor(result) {
      const key = resultIdentity(result);
      let icon = this._iconCache.get(key);
      if (icon)
        return icon;

      icon = new St.Icon(this._iconProps(result));
      this._iconCache.set(key, icon);
      return icon;
    }

    _applyRowIcon(row, result) {
      const content = row.get_child();
      if (!content)
        return;

      const current = row._spotlightIcon ?? null;
      const icon = this._iconFor(result);
      if (current === icon)
        return;

      const parent = icon.get_parent();
      if (parent && parent !== content)
        parent.remove_child(icon);

      if (icon.get_parent() !== content)
        content.insert_child_at_index(icon, 0);

      // The detached icon can still be cached for another result id; keep it
      // alive and only remove it from this row.
      if (current && current !== icon && current.get_parent() === content)
        content.remove_child(current);

      row._spotlightIcon = icon;
    }

    _adoptRowIcon(row, result) {
      const key = resultIdentity(result);
      if (this._iconCache.has(key)) {
        this._applyRowIcon(row, result);
        return;
      }

      const content = row.get_child();
      const icon = content?.get_children?.()[0] ?? null;
      if (icon) {
        this._iconCache.set(key, icon);
        row._spotlightIcon = icon;
      } else {
        this._applyRowIcon(row, result);
      }
    }

    _updateRow(row, result, query) {
      row.result = result;

      if (row._title)
        row._title.set_text(String(result?.title ?? ''));
      if (row._subtitle) {
        row._subtitle.set_text(String(result?.subtitle ?? ''));
        row._subtitle.visible = Boolean(result?.subtitle);
      }
      if (row._meta) {
        row._meta.set_text(String(result?.kind ?? ''));
        row._meta.visible = Boolean(result?.kind);
      }

      row.setQuery(query);
      this._applyRowIcon(row, result);
    }

    /**
     * Replace the grouped result list. Rows are pooled and only rebuilt when
     * the providerId+id sequence changes; an identical list only refreshes
     * the existing row data and the selection highlight.
     *
     * @param {{id?: string, title?: string, results?: object[]}[]} sections
     */
    setResults(sections) {
      if (this._destroyed)
        return;

      const groups = this._compact
        ? []
        : (Array.isArray(sections) ? sections : []);
      const limit = this._resultLimit();
      const prepared = [];
      const flat = [];
      let total = 0;

      for (const section of groups) {
        const results = Array.isArray(section?.results)
          ? section.results.filter(Boolean)
          : [];
        if (results.length === 0)
          continue;

        const visible = [];
        for (const result of results) {
          if (total >= limit)
            break;
          visible.push(result);
          flat.push(result);
          total++;
        }

        if (visible.length > 0)
          prepared.push({ section, results: visible });
        if (total >= limit)
          break;
      }

      this._lastResults = flat;
      this._syncSections(prepared);
      const nextKeys = flat.map(resultIdentity);
      const sameList =
        nextKeys.length === this._rowKeys.length &&
        nextKeys.every((key, index) => key === this._rowKeys[index]);

      if (sameList) {
        if (this._rows.length === 0) {
          this._showEmptyState();
          this._empty.show();
          this._syncResultsScrollHeight({ reset: true });
          this._updatePreview();
          return;
        }

        for (let i = 0; i < this._rows.length; i++)
          this._updateRow(this._rows[i], flat[i], this._query);

        this._syncResultsScrollHeight();
        const index = this._selectedIndex >= 0 &&
          this._selectedIndex < this._rows.length
          ? this._selectedIndex
          : 0;
        this._selectIndex(index);
        return;
      }

      // Recycle rows: detach them from the old section boxes before those
      // boxes are destroyed so no St actor is recreated for a new keystroke.
      for (const row of this._rowPool) {
        const parent = row.get_parent?.();
        if (parent)
          parent.remove_child(row);
      }

      for (const box of this._sectionBoxes) {
        try {
          box.destroy();
        } catch (error) {
          logError(error);
        }
      }
      this._sectionBoxes = [];
      this._rows = [];
      this._rowKeys = [];

      for (const { section, results } of prepared) {
        const sectionBox = new St.BoxLayout({
          style_class: 'spotlight-section',
          orientation: Clutter.Orientation.VERTICAL,
          x_expand: true,
        });
        const header = new St.BoxLayout({
          style_class: 'spotlight-section-header',
        });
        header.add_child(new St.Label({
          style_class: 'spotlight-section-title',
          text: String(section.title ?? section.id ?? ''),
        }));
        header.add_child(new St.Label({
          style_class: 'spotlight-section-count',
          text: String(results.length),
        }));
        sectionBox.add_child(header);

        for (const result of results) {
          let row = this._rowPool[this._rows.length];
          if (row) {
            this._updateRow(row, result, this._query);
          } else {
            row = new SpotlightResultRow(result, {
              query: this._query,
              onActivate: activated => this._activateResult(activated, false),
            });
            this._rowPool.push(row);
            this._adoptRowIcon(row, result);
            // Connect once per row object: pooled rows are only adopted and
            // updated on subsequent setResults() calls.
            row.connect('context-menu', (emitter, _row, event) => {
              this._showActionMenu(event, emitter);
            });
          }

          sectionBox.add_child(row);
          this._rows.push(row);
          this._rowKeys.push(resultIdentity(result));
        }

        this._results.add_child(sectionBox);
        this._sectionBoxes.push(sectionBox);
      }

      if (this._sections.length === 0) {
        this._showEmptyState();
        this._syncResultsScrollHeight({ reset: true });
      } else {
        this._empty.hide();
        // A new result set starts at the top; the adjustment is only moved
        // afterwards by the keyboard selection helper.
        this._syncResultsScrollHeight({ reset: true });
        this._selectIndex(0);
      }

      this._updatePreview();
    }

    /**
     * Keep the section index model in one place for every result path:
     * cached first paint, debounced search and streamed results all converge
     * on setResults().
     */
    _syncSections(prepared) {
      this._sections = [];
      let firstIndex = 0;
      for (const { results } of prepared) {
        this._sections.push({ firstIndex, count: results.length });
        firstIndex += results.length;
      }
    }

    _showEmptyState() {
      const hasQuery = this._query.trim().length > 0;
      this._emptyTitle.set_text(hasQuery ? 'Brak wyników' : 'Zacznij pisać');
      this._emptyHint.set_text(
        hasQuery
          ? 'Spróbuj innej frazy lub prefiksu >, ssh, sys, snip, docker'
          : 'Wpisz nazwę aplikacji, pliku lub komendę'
      );
      this._empty.show();
    }

    _onTextChanged() {
      if (this._destroyed)
        return;

      this._query = this._entry.get_text();
      // A new query always starts from the narrow, full-width list. The
      // preview only ever appears after an explicit Ctrl+Space.
      this._hidePreview();
      const query = this._query.trim();
      this._setCompact(query === '');
      this._updateModeFooter();

      if (query === '') {
        this._cancelSearch();
        this._closePreview();
        this.setResults([]);
        this._options.onQueryChanged?.(this._query);
        return;
      }

      // Synchronous first paint from the LRU cache, before the debounce and
      // before any D-Bus round-trip. This keeps a repeated query at one frame.
      this._renderCached(query);

      this._scheduleSearch();
      this._options.onQueryChanged?.(this._query);
    }

    _searchMode(query = this._query) {
      const detected = queryMode(query);
      if (detected !== '')
        return detected;

      const configured = this._options?.mode;
      return typeof configured === 'string' ? configured : this._configuredMode;
    }

    _updateModeFooter() {
      if (!this._footerMode)
        return;
      const mode = this._searchMode(this._query);
      this._footerMode.set_text(mode === '' ? '' : `tryb: ${mode}`);
      this._footerMode.visible = mode !== '';
    }

    _renderCached(query) {
      const cached = lookup(cacheKey(query, this._searchMode(query)));
      if (!Array.isArray(cached) || cached.length === 0)
        return false;

      this.setResults(this._sectionsFromResponse({ results: cached }));
      this._updateFooter(
        this._options?.getSource?.() ?? this._options?.source ?? 'offline'
      );
      return true;
    }

    _updateFooter(source) {
      if (this._footerSource) {
        this._footerSource.set_text(
          source === 'daemon' ? 'daemon' : 'offline'
        );
      }
    }

    setSource(source) {
      if (this._footerSource) {
        this._footerSource.set_text(source === 'daemon' ? 'daemon' : 'offline');
      }
    }

    refreshSearch() {
      if (this._destroyed || !this._isOpen)
        return;

      const query = this._query.trim();
      if (query === '')
        return;

      this._scheduleSearch();
    }

    _cancelSearch() {
      this._searchToken++;
      if (this._searchTimer) {
        clearTimeout(this._searchTimer);
        this._searchTimer = 0;
      }
    }

    _scheduleSearch() {
      if (this._destroyed)
        return;

      this._cancelSearch();
      const token = this._searchToken;
      const query = this._query.trim();

      if (query === '') {
        this.setResults([]);
        return;
      }

      this._searchTimer = setTimeout(() => {
        this._searchTimer = 0;
        this._performSearch(query, token);
      }, SEARCH_DEBOUNCE_MS);
    }

    async _performSearch(query, token) {
      const limit = this._resultLimit();
      const mode = this._searchMode(query);
      const frontendSearch = this._options.search;
      const registry = this._options.registry;
      const search = typeof frontendSearch === 'function'
        ? frontendSearch
        : (typeof registry?.search === 'function'
          ? (needle, options) => registry.search(needle, options)
          : null);

      if (!search) {
        if (token === this._searchToken)
          this.setResults([]);
        return;
      }

      let response;
      try {
        // extension.js caches max-results and owns the daemon/local choice;
        // the modal never enumerates providers itself.
        response = await search(query, { limit, mode });
      } catch (error) {
        if (!this._destroyed && token === this._searchToken) {
          logError(error);
          this.setResults([]);
        }
        return;
      }

      if (
        this._destroyed ||
        token !== this._searchToken ||
        this._query.trim() !== query
      ) {
        return;
      }

      const next = Array.isArray(response?.results) ? response.results : [];
      const previous = this._lastResults;
      const stable = stabilize(previous, next);
      const sameRows = stable === previous &&
        stable.length > 0 &&
        this._rowKeys.length === stable.length;

      this._lastResults = stable;
      remember(cacheKey(query, mode), stable);

      if (!sameRows)
        this.setResults(this._sectionsFromResponse({ ...response, results: stable }));

      this._updateFooter(response?.source ?? 'offline');
    }

    _sectionsFromResponse(response) {
      const results = Array.isArray(response?.results) ? response.results : [];
      const registry = this._options.registry;
      const providers = new Map();

      if (registry && typeof registry.list === 'function') {
        for (const provider of registry.list())
          providers.set(provider.id, provider);
      }

      const sections = [];
      const byProvider = new Map();

      for (const result of results) {
        if (!result)
          continue;

        const providerId = String(result.providerId ?? '');
        let section = byProvider.get(providerId);
        if (!section) {
          section = {
            id: providerId,
            title: providers.get(providerId)?.title ?? providerId,
            results: [],
          };
          byProvider.set(providerId, section);
          sections.push(section);
        }
        section.results.push(result);
      }

      return sections;
    }

    _rowForIndex(index) {
      if (!Number.isInteger(index) || index < 0 || index >= this._rows.length)
        return null;
      return this._rows[index] ?? null;
    }

    _selectedRow() {
      return this._rowForIndex(this._selectedIndex);
    }

    _selectIndex(index) {
      if (this._rows.length === 0) {
        this._selectedIndex = -1;
        return;
      }

      const next = Math.max(0, Math.min(index, this._rows.length - 1));
      if (this._selectedIndex >= 0 && this._rows[this._selectedIndex])
        this._rows[this._selectedIndex].setSelected(false);

      this._selectedIndex = next;
      this._rows[next].setSelected(true);
      this._updatePreview();
      this._scrollSelectedIntoView();
    }

    _moveSelection(delta) {
      if (this._rows.length === 0)
        return;

      if (this._selectedIndex < 0) {
        this._selectIndex(0);
        return;
      }

      this._selectIndex(this._selectedIndex + delta);
    }

    _moveSection(direction) {
      if (this._sections.length === 0)
        return;

      // With a single section Tab must still move through its rows; otherwise
      // the key looks dead even though the section model is correct.
      if (this._sections.length === 1) {
        this._moveSelection(direction);
        return;
      }

      let current = 0;
      for (let i = 0; i < this._sections.length; i++) {
        const section = this._sections[i];
        if (
          this._selectedIndex >= section.firstIndex &&
          this._selectedIndex < section.firstIndex + section.count
        ) {
          current = i;
          break;
        }
      }

      const next = current + direction;
      if (next < 0 || next >= this._sections.length)
        return;

      this._selectIndex(this._sections[next].firstIndex);
    }

    _actionDeps() {
      if (!this._actionDepsValue)
        this._actionDepsValue = createActionDeps();
      return this._actionDepsValue;
    }

    _reportActivationError(error) {
      try {
        logError(error);
      } catch {
        // Logging must not prevent the modal from closing.
      }
    }

    _activateResult(result, secondary) {
      if (!result || result.disabled)
        return;

      let invoked = false;
      let failure = null;
      let action = null;

      try {
        const actions = parseActions(result);
        action = secondary ? actions.secondary : actions.primary;

        // Keep support for the in-process providers: their action fields are
        // functions, sometimes wrapped in plain objects with callbacks.
        if (action === null || action === undefined) {
          const rawActions = result?.actions;
          if (rawActions && typeof rawActions === 'object')
            action = secondary ? rawActions.secondary : rawActions.primary;
        }

        // Native SearchProvider2 results have activation metadata but no
        // serialized action descriptors; route them through the same runner.
        if ((action === null || action === undefined) && !secondary)
          action = result?.activation ?? null;

        if (typeof action === 'function') {
          action(result);
          invoked = true;
        } else if (action && typeof action === 'object') {
          const callback = action.callback ?? action.action ?? action.activate;
          if (typeof callback === 'function') {
            callback(result);
            invoked = true;
          } else {
            invoked = runAction(action, result, this._actionDeps());
          }
        } else if (action !== null && action !== undefined) {
          invoked = runAction(action, result, this._actionDeps());
        }

        if (!invoked && typeof result?.activate === 'function') {
          result.activate();
          invoked = true;
        }
      } catch (error) {
        failure = error;
        invoked = false;
      }

      if (!invoked) {
        const title = result?.title ?? result?.id ?? '';
        this._reportActivationError(
          failure ?? new Error(`nie udało się uruchomić: ${title}`)
        );
      }

      // Usage history belongs to the primary action only; secondary actions
      // (card 4) must not inflate the frecency counters.
      if (invoked && !secondary) {
        try {
          this._options.onResultActivated?.(result);
        } catch (error) {
          logError(error);
        }
      }

      this.close();
    }

    _activateSelected(secondary) {
      if (this._selectedIndex < 0 || !this._rows[this._selectedIndex])
        return;
      this._activateResult(this._rows[this._selectedIndex].result, secondary);
    }

    _selectedResult() {
      if (this._selectedIndex < 0 || !this._rows[this._selectedIndex])
        return null;
      return this._rows[this._selectedIndex].result ?? null;
    }

    _onCapturedEvent(_actor, event) {
      if (this._destroyed || event.type() !== Clutter.EventType.KEY_PRESS)
        return Clutter.EVENT_PROPAGATE;

      const symbol = event.get_key_symbol();
      const state = event.get_state();
      const control = (state & Clutter.ModifierType.CONTROL_MASK) !== 0;
      const shift = (state & Clutter.ModifierType.SHIFT_MASK) !== 0;

      switch (symbol) {
      case Clutter.KEY_Escape:
        // In the preview the first Escape returns to the full-width list; a
        // second one closes the modal.
        if (this._previewVisible || this._previewMode) {
          this._hidePreview();
          return Clutter.EVENT_STOP;
        }
        this.close();
        return Clutter.EVENT_STOP;

      case Clutter.KEY_Up:
        this._moveSelection(-1);
        return Clutter.EVENT_STOP;

      case Clutter.KEY_Down:
        this._moveSelection(1);
        return Clutter.EVENT_STOP;

      case Clutter.KEY_Tab:
        this._moveSection(shift ? -1 : 1);
        return Clutter.EVENT_STOP;

      case Clutter.KEY_ISO_Left_Tab:
        this._moveSection(-1);
        return Clutter.EVENT_STOP;

      case Clutter.KEY_Return:
      case Clutter.KEY_KP_Enter:
      case Clutter.KEY_ISO_Enter:
        this._activateSelected(control);
        return Clutter.EVENT_STOP;

      case Clutter.KEY_k:
      case Clutter.KEY_K:
        if (control) {
          this._showActionMenu(null, this._selectedRow());
          return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;

      case Clutter.KEY_p:
      case Clutter.KEY_P:
        if (control) {
          this._pinSelected();
          return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;

      case Clutter.KEY_space:
        // Ctrl+Space opens Quick Look; plain Space belongs to the entry so a
        // query such as "spot light" can contain spaces.
        if (control) {
          this._togglePreview();
          return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;

      default:
        return Clutter.EVENT_PROPAGATE;
      }
    }

    _previewEnabled() {
      if (!this._settings)
        return true;
      try {
        return this._settings.get_boolean('preview-enabled');
      } catch {
        return true;
      }
    }

    _pinSelected() {
      const result = this._selectedResult();
      if (!result)
        return;

      try {
        this._options.onResultPinned?.(result);
      } catch (error) {
        logError(error);
      }
    }

    _showActionMenu(event = null, row = null) {
      if (this._destroyed)
        return;

      const target = row ?? this._selectedRow();
      if (!target)
        return;

      // Right-click emits on both press and release; keep the already open
      // menu for this row instead of rebuilding it on the release edge.
      if (this._actionMenu?.isOpen && this._actionMenu.sourceActor === target)
        return;

      const targetIndex = this._rows.indexOf(target);
      if (targetIndex >= 0 && targetIndex !== this._selectedIndex)
        this._selectIndex(targetIndex);

      const result = target.result;
      if (!result)
        return;

      const items = buildActionMenu(result);
      if (items.length === 0)
        return;

      this._closeActionMenu();

      const created = createPopupActionMenu(
        PopupMenu,
        St,
        target,
        items,
        item => {
          try {
            if (item.descriptor)
              runAction(item.descriptor, result, this._actionDeps());
            else
              item.callback?.(result);
          } catch (error) {
            logError(error);
          }
        }
      );
      if (!created)
        return;

      if (!this._menuManager)
        this._menuManager = new PopupMenu.PopupMenuManager(this);
      this._menuManager.addMenu(created.menu);

      Main.uiGroup.add_child(created.menu.actor);
      this._actionMenu = created.menu;

      created.menu.connect('menu-closed', () => {
        if (this._actionMenu !== created.menu)
          return;
        this._actionMenu = null;
        this._entry?.grab_key_focus();
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
          try {
            created.menu.destroy();
          } catch (error) {
            logError(error);
          }
          return GLib.SOURCE_REMOVE;
        });
      });

      const openParams = typeof event?.type === 'function'
        ? { triggerEvent: event }
        : {};
      created.menu.open(openParams);
    }

    _closeActionMenu() {
      const menu = this._actionMenu;
      this._actionMenu = null;
      if (!menu)
        return;

      try {
        menu.close({ animate: false });
      } catch (error) {
        logError(error);
      }
      try {
        menu.destroy();
      } catch (error) {
        logError(error);
      }
    }

    _previewPath(result) {
      if (!result)
        return '';
      const path = result.preview?.path ??
        result.filePath ??
        (result.providerId === 'files' ? result.id : null);
      return path ? String(path) : '';
    }

    _togglePreview() {
      if (!this._previewEnabled())
        return false;

      const result = this._selectedResult();
      if (!result)
        return false;

      if (this._previewVisible) {
        this._hidePreview();
        return true;
      }

      const path = this._previewPath(result);
      const model = buildPreviewModel(result, true);
      if (!model && !path)
        return false;

      // Ctrl+Space is the only path that widens the body with the sidebar.
      this._previewVisible = true;
      this._previewMode = false;
      this._previewResultKey = resultIdentity(result);
      this._updatePreview(true);
      this._previewVisible = true;

      if (path) {
        this._previewMode = true;
        this._previewResultKey = resultIdentity(result);
        this._preview?.previewFile(path);
      }
      return true;
    }

    _hidePreview() {
      const hadPreview = this._previewVisible ||
        this._previewMode ||
        this._preview?.visible === true ||
        this._preview?.isPreviewOpen?.() === true;
      this._previewVisible = false;
      this._previewMode = false;
      this._previewResultKey = '';
      if (hadPreview)
        this._preview?.clear();
      else
        this._preview?.hide();
    }

    _closePreview() {
      this._hidePreview();
    }

    _updatePreview(force = false) {
      this._previewToken++;

      if (!this._preview) {
        this._previewVisible = false;
        this._previewMode = false;
        this._previewResultKey = '';
        return;
      }

      if (!this._previewEnabled()) {
        this._previewVisible = false;
        this._previewMode = false;
        this._previewResultKey = '';
        this._preview.clear();
        return;
      }

      // Default state and every query change: the preview panel is hidden
      // and the result list owns the full modal width.
      if (!this._previewVisible && !force) {
        if (this._preview.visible)
          this._preview.clear();
        return;
      }

      const result = this._selectedResult();
      const key = resultIdentity(result);

      // A refresh of the same selected result must not tear down an open
      // Quick Look preview.
      if (this._previewMode && key === this._previewResultKey)
        return;

      this._previewMode = false;
      this._previewResultKey = key;

      const model = buildPreviewModel(result, true);
      if (!model) {
        this._previewVisible = false;
        this._preview.clear();
        return;
      }

      this._preview.setModel(model, {
        onPrimary: () => this._activateResult(result, false),
        onSecondary: () => this._activateResult(result, true),
        onActions: () => this._showActionMenu(),
      });
      this._preview.show();
    }

    _getMonitor() {
      const layoutManager = Main.layoutManager;
      let mode = 'pointer';
      try {
        mode = this._settings?.get_string('open-on-monitor') ?? 'pointer';
      } catch {
        mode = 'pointer';
      }

      if (mode === 'primary')
        return layoutManager?.primaryMonitor ?? this._fallbackMonitor();

      // Both "pointer" and "focused" resolve to the monitor of the active
      // window/pointer in the Shell; currentMonitor is the best available.
      return layoutManager?.currentMonitor ??
        layoutManager?.primaryMonitor ??
        this._fallbackMonitor();
    }

    _fallbackMonitor() {
      return { x: 0, y: 0, width: 1920, height: 1080 };
    }

    open() {
      if (this._destroyed || this._isOpen)
        return;

      this._isOpen = true;
      this._query = '';
      this._hidePreview();
      this._applyPanelStyle();
      this._setCompact(true);
      this._entry.set_text('');
      this._updateModeFooter();
      this._cancelSearch();
      this.setResults([]);

      const monitor = this._getMonitor();
      const x = monitor.x + Math.floor((monitor.width - PANEL_WIDTH) / 2);
      const y = monitor.y + Math.floor(monitor.height * TOP_RATIO);
      this.set_position(x, y);

      Main.uiGroup.add_child(this);
      this.show();
      // The clone offset depends on the final panel origin; recompute it after
      // every open so a monitor/pointer change cannot leave a stale backdrop.
      this._updatePanelBlurGeometry();
      this._syncResultsScrollHeight({ reset: true });

      try {
        this._grab = Main.pushModal(this);
      } catch (error) {
        this._grab = null;
        logError(error);
      }

      this._entry.grab_key_focus();
    }

    close() {
      if (!this._isOpen)
        return;

      this._isOpen = false;
      this._cancelSearch();
      this._previewToken++;
      this._closePreview();
      this._closeActionMenu();

      if (this._grab) {
        try {
          Main.popModal(this._grab);
        } catch (error) {
          logError(error);
        }
        this._grab = null;
      }

      const parent = this.get_parent();
      if (parent)
        parent.remove_child(this);

      this.hide();
      this._options.onClose?.();
    }

    toggle() {
      if (this._isOpen)
        this.close();
      else
        this.open();
    }

    get isOpen() {
      return this._isOpen;
    }

    destroy() {
      if (this._destroyed)
        return;

      this.close();
      this._cancelSearch();
      this._disconnectStyleSettings();
      this._removePanelBlur();
      for (const id of this._panelSizeChangedIds) {
        try {
          this._panel?.disconnect(id);
        } catch (error) {
          logError(error);
        }
      }
      this._panelSizeChangedIds = [];
      this._destroyed = true;

      if (this._capturedId) {
        this.disconnect(this._capturedId);
        this._capturedId = 0;
      }
      if (this._textChangedId && this._entry?.clutter_text) {
        this._entry.clutter_text.disconnect(this._textChangedId);
        this._textChangedId = 0;
      }

      for (const row of this._rowPool) {
        try {
          row.destroy();
        } catch (error) {
          logError(error);
        }
      }
      this._rowPool = [];
      this._rows = [];
      this._rowKeys = [];
      this._sections = [];
      this._sectionBoxes = [];
      this._iconCache.clear();

      super.destroy();
    }
  }
);