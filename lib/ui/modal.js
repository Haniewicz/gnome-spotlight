import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { SpotlightResultRow } from './resultRow.js';

const PANEL_WIDTH = 860;
const PREVIEW_WIDTH = 296;
const TOP_RATIO = 0.14;

/**
 * Spotlight launcher modal. extension.js supplies options.registry; typing
 * runs a debounced registry.search() and feeds the grouped results back
 * through setResults().
 */
export const SpotlightModal = GObject.registerClass(
  { GTypeName: 'SpotlightModal' },
  class SpotlightModal extends St.BoxLayout {
    _init(settings = null, options = {}) {
      super._init({
        style_class: 'spotlight-modal',
        vertical: true,
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
      this._selectedIndex = -1;
      this._query = '';
      this._capturedId = 0;
      this._textChangedId = 0;
      this._searchTimer = 0;
      this._searchToken = 0;

      this._buildUI();

      this._capturedId = this.connect(
        'captured-event',
        this._onCapturedEvent.bind(this)
      );
    }

    _buildUI() {
      const searchRow = new St.BoxLayout({
        style_class: 'spotlight-search-row',
        spacing: 14,
      });
      this.add_child(searchRow);

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

      searchRow.add_child(new St.Label({
        style_class: 'spotlight-scope',
        text: 'Super + Space',
      }));

      this._body = new St.BoxLayout({
        style_class: 'spotlight-body',
        x_expand: true,
      });
      this.add_child(this._body);

      this._results = new St.BoxLayout({
        style_class: 'spotlight-results',
        vertical: true,
        x_expand: true,
      });
      this._body.add_child(this._results);

      // Preview is a card-4 concern. Keeping the column here means the modal
      // layout already has its final 860/296 split.
      this._preview = new St.BoxLayout({
        style_class: 'spotlight-preview',
        vertical: true,
        visible: false,
      });
      this._preview.set_width(PREVIEW_WIDTH);
      this._body.add_child(this._preview);

      this._empty = new St.BoxLayout({
        style_class: 'spotlight-empty',
        vertical: true,
        x_expand: true,
        y_expand: true,
        x_align: Clutter.ActorAlign.CENTER,
        y_align: Clutter.ActorAlign.CENTER,
        spacing: 8,
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

      const footer = new St.BoxLayout({
        style_class: 'spotlight-footer',
        spacing: 16,
      });
      this.add_child(footer);
      footer.add_child(new St.Label({
        style_class: 'spotlight-footer-hints',
        text: '↑↓ wybór   ⏎ otwórz   Space podgląd   Tab sekcje   Esc zamknij',
        x_expand: true,
      }));
    }

    /**
     * Replace the whole grouped result list.
     *
     * @param {{id?: string, title?: string, results?: object[]}[]} sections
     */
    setResults(sections) {
      if (this._destroyed)
        return;

      const groups = Array.isArray(sections) ? sections : [];

      for (const row of this._rows)
        row.destroy();
      this._rows = [];
      this._sections = [];
      this._selectedIndex = -1;

      for (const child of this._results.get_children()) {
        if (child !== this._empty)
          child.destroy();
      }

      let visibleSections = 0;

      for (const section of groups) {
        const results = Array.isArray(section?.results)
          ? section.results.filter(Boolean)
          : [];
        if (results.length === 0)
          continue;

        const sectionBox = new St.BoxLayout({
          style_class: 'spotlight-section',
          vertical: true,
          x_expand: true,
        });
        const header = new St.BoxLayout({
          style_class: 'spotlight-section-header',
          spacing: 8,
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

        const firstIndex = this._rows.length;
        for (const result of results) {
          const row = new SpotlightResultRow(result, {
            query: this._query,
            onActivate: activated => this._activateResult(activated, false),
          });
          sectionBox.add_child(row);
          this._rows.push(row);
        }

        this._results.add_child(sectionBox);
        this._sections.push({ firstIndex, count: results.length });
        visibleSections++;
      }

      if (visibleSections === 0) {
        this._showEmptyState();
      } else {
        this._empty.hide();
        this._selectIndex(0);
      }

      this._updatePreview();
    }

    _showEmptyState() {
      const hasQuery = this._query.trim().length > 0;
      this._emptyTitle.set_text(hasQuery ? 'Brak wyników' : 'Zacznij pisać');
      this._emptyHint.set_text(
        hasQuery
          ? 'Spróbuj innej frazy lub prefiksu > dla komend'
          : 'Wpisz nazwę aplikacji, pliku lub komendę'
      );
      this._empty.show();
    }

    _onTextChanged() {
      if (this._destroyed)
        return;

      this._query = this._entry.get_text();
      this._scheduleSearch();
      this._options.onQueryChanged?.(this._query);
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
      }, 40);
    }

    async _performSearch(query, token) {
      const registry = this._options.registry;
      if (!registry || typeof registry.search !== 'function') {
        if (token === this._searchToken)
          this.setResults([]);
        return;
      }

      let response;
      try {
        response = await registry.search(query);
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

      this.setResults(this._sectionsFromResponse(response));
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

    _activateResult(result, secondary) {
      if (!result || result.disabled)
        return;

      const action = secondary
        ? result?.actions?.secondary
        : result?.actions?.primary;

      let invoked = false;
      try {
        if (typeof action === 'function') {
          action(result);
          invoked = true;
        } else if (action && typeof action.callback === 'function') {
          action.callback(result);
          invoked = true;
        } else if (typeof result?.activate === 'function') {
          result.activate();
          invoked = true;
        }
      } catch (error) {
        logError(error);
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

    _onCapturedEvent(_actor, event) {
      if (this._destroyed || event.type() !== Clutter.EventType.KEY_PRESS)
        return Clutter.EVENT_PROPAGATE;

      const symbol = event.get_key_symbol();
      const state = event.get_state();
      const control = (state & Clutter.ModifierType.CONTROL_MASK) !== 0;
      const shift = (state & Clutter.ModifierType.SHIFT_MASK) !== 0;

      switch (symbol) {
      case Clutter.KEY_Escape:
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
          // Card 4: action menu.
          this._showActionMenu();
          return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;

      case Clutter.KEY_space:
        // Never swallow Space: it must stay typable in the entry. Preview is
        // a card-4 stub.
        return Clutter.EVENT_PROPAGATE;

      default:
        return Clutter.EVENT_PROPAGATE;
      }
    }

    _showActionMenu() {
      // Stub for card 4 (Ctrl+K).
    }

    _togglePreview() {
      // Stub for card 4 (Space).
    }

    _updatePreview() {
      // The preview pane is implemented in card 4. It stays hidden for now;
      // the `preview-enabled` setting will gate it there.
      if (this._preview)
        this._preview.hide();
    }

    _getMonitor() {
      const layoutManager = Main.layoutManager;
      return layoutManager?.currentMonitor ??
        layoutManager?.primaryMonitor ??
        { x: 0, y: 0, width: 1920, height: 1080 };
    }

    open() {
      if (this._destroyed || this._isOpen)
        return;

      this._isOpen = true;
      this._query = '';
      this._entry.set_text('');
      this._cancelSearch();
      this.setResults([]);

      const monitor = this._getMonitor();
      const x = monitor.x + Math.floor((monitor.width - PANEL_WIDTH) / 2);
      const y = monitor.y + Math.floor(monitor.height * TOP_RATIO);
      this.set_position(x, y);

      Main.uiGroup.add_child(this);
      this.show();

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
      this._destroyed = true;

      if (this._capturedId) {
        this.disconnect(this._capturedId);
        this._capturedId = 0;
      }
      if (this._textChangedId && this._entry?.clutter_text) {
        this._entry.clutter_text.disconnect(this._textChangedId);
        this._textChangedId = 0;
      }

      for (const row of this._rows)
        row.destroy();
      this._rows = [];

      super.destroy();
    }
  }
);