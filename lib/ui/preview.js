const PREVIEW_WIDTH = 296;
const MAX_ROWS = 6;

function stringValue(value) {
  if (value === null || value === undefined)
    return '';
  return String(value);
}

function normalizeAction(action) {
  if (typeof action === 'function')
    return { callback: action, label: '' };

  if (action && typeof action === 'object') {
    const callback = action.callback ?? action.action ?? action.activate;
    if (typeof callback === 'function')
      return { callback, label: stringValue(action.label) };
  }

  return null;
}

/**
 * Build the metadata table shown in the preview pane.
 *
 * Input rows use the provider contract (`[[label, value], ...]`); empty labels
 * or values are skipped and the table never grows beyond six rows.
 *
 * @param {object|null|undefined} preview
 * @param {number} [maxRows]
 * @returns {[string, string][]}
 */
export function buildPreviewRows(preview, maxRows = MAX_ROWS) {
  const limit = maxRows === null || maxRows === undefined ? MAX_ROWS : Number(maxRows);
  const cap = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : MAX_ROWS;
  if (cap === 0)
    return [];

  const rows = Array.isArray(preview?.rows) ? preview.rows : [];
  const result = [];

  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 2)
      continue;

    const label = stringValue(row[0]).trim();
    const value = stringValue(row[1]).trim();
    if (label === '' || value === '')
      continue;

    result.push([label, value]);
    if (result.length >= cap)
      break;
  }

  return result;
}

/**
 * Pure preview model consumed by the St panel. Returns null when the feature
 * is disabled or the result has no `preview` object.
 *
 * @param {object|null|undefined} result
 * @param {boolean} [enabled]
 * @returns {object|null}
 */
export function buildPreviewModel(result, enabled = true) {
  if (!enabled || !result || !result.preview || typeof result.preview !== 'object')
    return null;

  const rows = buildPreviewRows(result.preview);
  return {
    title: stringValue(result.title),
    kind: stringValue(result.kind),
    icon: result.icon ?? null,
    rows,
    description: stringValue(result.preview.description),
    primary: normalizeAction(result.actions?.primary),
    secondary: normalizeAction(result.actions?.secondary),
  };
}

let PreviewPanelClass = null;

/**
 * Create the preview panel. GI modules are injected so this file stays
 * importable from plain gjs (the pure helpers above are unit-tested there).
 *
 * @param {object} St
 * @param {object} GObject
 * @param {object} [Clutter]
 * @returns {object}
 */
export function createPreviewPanel(St, GObject, Clutter = null) {
  const vertical = Clutter?.Orientation?.VERTICAL ?? 1;
  if (!PreviewPanelClass) {
    PreviewPanelClass = GObject.registerClass(
      { GTypeName: 'SpotlightPreviewPanel' },
      class SpotlightPreviewPanel extends St.BoxLayout {
        _init() {
          super._init({
            style_class: 'spotlight-preview',
            orientation: vertical,
            visible: false,
            x_expand: false,
          });

          this.set_width(PREVIEW_WIDTH);
          this._model = null;
          this._onPrimary = null;
          this._onSecondary = null;

          this._iconBox = new St.Bin({
            style_class: 'spotlight-preview-icon-box',
            x_expand: false,
          });
          this._iconBox.set_size(76, 76);
          this.add_child(this._iconBox);

          this._title = new St.Label({
            style_class: 'spotlight-preview-title',
            text: '',
            x_expand: true,
          });
          this.add_child(this._title);

          this._kind = new St.Label({
            style_class: 'spotlight-preview-kind',
            text: '',
            x_expand: true,
            visible: false,
          });
          this.add_child(this._kind);

          this._divider = new St.Widget({
            style_class: 'spotlight-preview-divider',
            x_expand: true,
          });
          this.add_child(this._divider);

          this._metaBox = new St.BoxLayout({
            style_class: 'spotlight-preview-meta',
            orientation: vertical,
            x_expand: true,
          });
          this.add_child(this._metaBox);

          this._textLabel = new St.Label({
            style_class: 'spotlight-preview-text',
            text: '',
            x_expand: true,
          });
          this._textLabel.clutter_text.line_wrap = true;

          this._textScroll = new St.ScrollView({
            style_class: 'spotlight-preview-scroll',
            x_expand: true,
            y_expand: true,
            visible: false,
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
          });
          this._textScroll.add_child(this._textLabel);
          this.add_child(this._textScroll);

          this._buttons = new St.BoxLayout({
            style_class: 'spotlight-preview-buttons',
            x_expand: true,
          });
          this.add_child(this._buttons);

          this._primaryLabel = new St.Label({
            style_class: 'spotlight-preview-button-label',
            text: 'Otwórz ⏎',
            x_expand: true,
          });
          this._primaryButton = new St.Button({
            style_class: 'spotlight-preview-button spotlight-preview-button-primary',
            x_expand: true,
            reactive: true,
            can_focus: true,
          });
          this._primaryButton.set_child(this._primaryLabel);
          this._buttons.add_child(this._primaryButton);

          this._secondaryLabel = new St.Label({
            style_class: 'spotlight-preview-button-label',
            text: 'Akcje',
            x_expand: true,
          });
          this._secondaryButton = new St.Button({
            style_class: 'spotlight-preview-button',
            x_expand: true,
            reactive: false,
            can_focus: true,
          });
          this._secondaryButton.set_child(this._secondaryLabel);
          this._buttons.add_child(this._secondaryButton);

          this._primaryButton.connect('clicked', () => {
            if (this._onPrimary)
              this._onPrimary();
          });
          this._secondaryButton.connect('clicked', () => {
            if (this._onSecondary)
              this._onSecondary();
          });
        }

        _replaceIcon(icon) {
          for (const child of this._iconBox.get_children())
            child.destroy();

          const props = {
            style_class: 'spotlight-preview-icon',
            icon_size: 44,
          };
          if (typeof icon === 'string' && icon !== '')
            props.icon_name = icon;
          else if (icon)
            props.gicon = icon;
          else
            props.icon_name = 'application-x-executable-symbolic';

          this._iconBox.set_child(new St.Icon(props));
        }

        _clearRows() {
          for (const child of this._metaBox.get_children())
            child.destroy();
        }

        _renderRows(rows) {
          this._clearRows();
          for (const [label, value] of rows) {
            const row = new St.BoxLayout({
              style_class: 'spotlight-preview-meta-row',
              x_expand: true,
            });
            row.add_child(new St.Label({
              style_class: 'spotlight-preview-meta-label',
              text: label,
              x_expand: true,
            }));
            row.add_child(new St.Label({
              style_class: 'spotlight-preview-meta-value',
              text: value,
            }));
            this._metaBox.add_child(row);
          }
        }

        /**
         * @param {object} model result of buildPreviewModel()
         * @param {{onPrimary?: Function, onSecondary?: Function}} [handlers]
         */
        setModel(model, handlers = {}) {
          if (!model)
            return;

          this._model = model;
          this._onPrimary = handlers.onPrimary ?? null;
          this._onSecondary = handlers.onSecondary ?? null;

          this._replaceIcon(model.icon);
          this._title.set_text(model.title || '');
          this._kind.set_text(model.kind || '');
          this._kind.visible = Boolean(model.kind);
          this._renderRows(model.rows);
          this._divider.visible = model.rows.length > 0 || Boolean(model.kind);

          const primaryLabel = model.primary?.label || 'Otwórz ⏎';
          const secondaryLabel = model.secondary?.label || 'Akcje';
          this._primaryLabel.set_text(primaryLabel);
          this._secondaryLabel.set_text(secondaryLabel);

          this._primaryButton.reactive = Boolean(this._onPrimary);
          this._secondaryButton.reactive = Boolean(this._onSecondary);
          if (this._onPrimary)
            this._primaryButton.remove_style_class_name('spotlight-preview-button-disabled');
          else
            this._primaryButton.add_style_class_name('spotlight-preview-button-disabled');
          if (this._onSecondary)
            this._secondaryButton.remove_style_class_name('spotlight-preview-button-disabled');
          else
            this._secondaryButton.add_style_class_name('spotlight-preview-button-disabled');

          this._textLabel.set_text('');
          this._textScroll.hide();
          this.show();
        }

        /**
         * Show a text excerpt below the metadata table.
         *
         * @param {string} text
         */
        setTextPreview(text) {
          this._textLabel.set_text(String(text ?? ''));
          this._textScroll.show();
          this.show();
        }

        clear() {
          this._model = null;
          this._onPrimary = null;
          this._onSecondary = null;
          this._clearRows();
          this._textLabel.set_text('');
          this._textScroll.hide();
          this.hide();
        }
      }
    );
  }

  return new PreviewPanelClass();
}

export { PREVIEW_WIDTH, MAX_ROWS, MAX_ROWS as PREVIEW_MAX_ROWS };
export const buildRows = buildPreviewRows;
export const buildModel = buildPreviewModel;

export default {
  buildPreviewRows,
  buildPreviewModel,
  createPreviewPanel,
  PREVIEW_WIDTH,
  PREVIEW_MAX_ROWS: MAX_ROWS,
};