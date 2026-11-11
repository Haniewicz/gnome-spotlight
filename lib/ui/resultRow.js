import GObject from 'gi://GObject';
import St from 'gi://St';

import { matchPositions } from '../fuzzy.js';

function escapeMarkup(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function titleMarkup(title, query) {
  const match = matchPositions(query, title);
  if (!match.matched || match.positions.length === 0)
    return escapeMarkup(title);

  const highlighted = new Set(match.positions);
  let markup = '';
  let inside = false;

  for (let i = 0; i < title.length; i++) {
    const active = highlighted.has(i);
    if (active !== inside) {
      markup += active
        ? '<span foreground="#9cc7ff">'
        : '</span>';
      inside = active;
    }
    markup += escapeMarkup(title[i]);
  }

  if (inside)
    markup += '</span>';

  return markup;
}

/**
 * A single St result row. The row owns its visual state; the modal only
 * toggles `setSelected()`.
 */
export const SpotlightResultRow = GObject.registerClass(
  { GTypeName: 'SpotlightResultRow' },
  class SpotlightResultRow extends St.Button {
    _init(result, options = {}) {
      super._init({
        style_class: 'spotlight-row',
        reactive: true,
        track_hover: true,
        can_focus: false,
        x_expand: true,
      });

      this.result = result;
      this._onActivate = options.onActivate ?? null;
      this._selected = false;

      const content = new St.BoxLayout({
        style_class: 'spotlight-row-content',
        x_expand: true,
        spacing: 13,
      });
      this.set_child(content);

      const iconValue = result?.icon;
      const iconProps = {
        style_class: 'spotlight-row-icon',
        icon_size: 24,
      };
      if (typeof iconValue === 'string')
        iconProps.icon_name = iconValue;
      else if (iconValue)
        iconProps.gicon = iconValue;
      else
        iconProps.icon_name = 'application-x-executable-symbolic';
      content.add_child(new St.Icon(iconProps));

      const titles = new St.BoxLayout({
        style_class: 'spotlight-row-titles',
        vertical: true,
        x_expand: true,
        spacing: 2,
      });
      content.add_child(titles);

      this._title = new St.Label({
        style_class: 'spotlight-row-title',
        text: String(result?.title ?? ''),
        x_expand: true,
      });
      titles.add_child(this._title);

      this._subtitle = new St.Label({
        style_class: 'spotlight-row-subtitle',
        text: String(result?.subtitle ?? ''),
        x_expand: true,
        visible: Boolean(result?.subtitle),
      });
      titles.add_child(this._subtitle);

      this._meta = new St.Label({
        style_class: 'spotlight-row-meta',
        text: String(result?.kind ?? ''),
        visible: Boolean(result?.kind),
      });
      content.add_child(this._meta);

      if (options.query)
        this.setQuery(options.query);

      this.connect('clicked', () => {
        if (this._onActivate)
          this._onActivate(this.result);
      });
    }

    setQuery(query) {
      this._query = query;
      if (!this._title)
        return;

      if (!query || !this.result?.title) {
        this._title.set_text(String(this.result?.title ?? ''));
        return;
      }

      this._title.clutter_text.set_markup(
        titleMarkup(String(this.result.title), query)
      );
    }

    setSelected(selected) {
      const value = Boolean(selected);
      if (value === this._selected)
        return;

      this._selected = value;
      if (value)
        this.add_style_class_name('spotlight-row-selected');
      else
        this.remove_style_class_name('spotlight-row-selected');
    }

    get selected() {
      return this._selected;
    }
  }
);