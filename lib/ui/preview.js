import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import { gtypeName } from '../gtype.js';
import { classify, formatMeta, textSnippet } from '../preview-model.js';
import { iconProperties } from './icons.js';

const PREVIEW_WIDTH = 296;
const MAX_ROWS = 6;
const TEXT_PREVIEW_LINES = 200;
const IMAGE_MAX_WIDTH = PREVIEW_WIDTH - 40;
const IMAGE_MAX_HEIGHT = 260;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const THUMBNAIL_TIMEOUT_MS = 300;
const TEXT_TIMEOUT_MS = 800;

let GnomeDesktopPromise = null;
let GdkPixbufPromise = null;

function reportError(error) {
  try {
    if (typeof logError === 'function')
      logError(error);
  } catch {
    // Logging must never break the preview path.
  }
}

/**
 * Load the thumbnailer typelib lazily so importing this module (the unit test
 * suite does that) never depends on desktop-only GI namespaces.
 */
function loadGnomeDesktop() {
  if (!GnomeDesktopPromise) {
    GnomeDesktopPromise = (async () => {
      for (const spec of ['gi://GnomeDesktop?version=4.0', 'gi://GnomeDesktop']) {
        try {
          const module = await import(spec);
          return module.default ?? module;
        } catch {
          // Try the next namespace spelling/version.
        }
      }
      return null;
    })();
  }
  return GnomeDesktopPromise;
}

function loadGdkPixbuf() {
  if (!GdkPixbufPromise) {
    GdkPixbufPromise = (async () => {
      for (const spec of ['gi://GdkPixbuf?version=2.0', 'gi://GdkPixbuf']) {
        try {
          const module = await import(spec);
          return module.default ?? module;
        } catch {
          // Try the next namespace spelling/version.
        }
      }
      return null;
    })();
  }
  return GdkPixbufPromise;
}

function getThumbnailFactory(module) {
  if (!module)
    return null;

  // GNOME 4x exposes GnomeDesktop.DesktopThumbnailFactory; accept the older
  // GnomeDesktop.ThumbnailFactory spelling as well.
  const ThumbnailFactory =
    module.DesktopThumbnailFactory ?? module.ThumbnailFactory;
  if (!ThumbnailFactory || typeof ThumbnailFactory.new !== 'function')
    return null;

  const sizes = module.DesktopThumbnailSize ?? module.ThumbnailSize ?? {};
  const candidates = [sizes.LARGE, sizes.NORMAL, 1, 0];
  for (const size of candidates) {
    if (size === undefined || size === null)
      continue;
    try {
      const factory = ThumbnailFactory.new(size);
      if (factory)
        return factory;
    } catch {
      // Try a different size constant.
    }
  }

  return null;
}

function contentMimeType(path, info) {
  try {
    const mime = info?.get_content_type?.();
    if (typeof mime === 'string' && mime !== '')
      return mime;
  } catch {
    // Fall through to extension-based guessing.
  }

  try {
    const [guessed] = Gio.content_type_guess(path, null);
    if (typeof guessed === 'string' && guessed !== '')
      return guessed;
  } catch {
    // Fall through to the generic type.
  }

  return 'application/octet-stream';
}

function scalePixbuf(pixbuf, GdkPixbuf) {
  if (!pixbuf)
    return null;

  const width = pixbuf.get_width();
  const height = pixbuf.get_height();
  if (!(width > 0) || !(height > 0))
    return null;

  const ratio = Math.min(IMAGE_MAX_WIDTH / width, IMAGE_MAX_HEIGHT / height);
  if (!Number.isFinite(ratio) || ratio <= 0)
    return null;

  const targetWidth = Math.max(1, Math.round(width * ratio));
  const targetHeight = Math.max(1, Math.round(height * ratio));
  if (targetWidth === width && targetHeight === height)
    return pixbuf;

  try {
    const interpolation = GdkPixbuf?.InterpType?.BILINEAR ?? 2;
    return pixbuf.scale_simple(targetWidth, targetHeight, interpolation) ?? pixbuf;
  } catch (error) {
    reportError(error);
    return pixbuf;
  }
}

function pixbufToGicon(pixbuf) {
  try {
    const [ok, data] = pixbuf.save_to_bufferv('png', [], []);
    if (!ok || !data)
      return null;
    return Gio.BytesIcon.new(GLib.Bytes.new(data));
  } catch (error) {
    reportError(error);
    return null;
  }
}

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
  const path = stringValue(
    result.preview.path ??
      result.filePath ??
      (result.providerId === 'files' ? result.id : '')
  );
  return {
    title: stringValue(result.title),
    kind: stringValue(result.kind),
    icon: result.icon ?? null,
    rows,
    path,
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
      { GTypeName: gtypeName('PreviewPanel', import.meta.url) },
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
          this._onActions = null;
          this._destroyed = false;
          this._previewToken = 0;
          this._metaToken = 0;
          this._timeoutId = 0;
          this._previewPath = '';
          this._previewKind = '';
          this._previewOpen = false;
          this._image = null;

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

          // Raster previews (images / first PDF page). The child is always an
          // St.Icon backed by a GIcon, so get_preferred_height() is useful to
          // tests and to the box layout.
          this._imageBox = new St.Bin({
            style_class: 'spotlight-preview-image-box',
            x_expand: true,
            visible: false,
          });
          this.add_child(this._imageBox);

          this._textLabel = new St.Label({
            style_class: 'spotlight-preview-text',
            text: '',
            x_expand: true,
          });
          this._textLabel.clutter_text.line_wrap = true;

          this._officeHint = new St.Label({
            style_class: 'spotlight-preview-office',
            text: '',
            x_expand: true,
            visible: false,
          });
          this._officeHint.clutter_text.line_wrap = true;

          // St.ScrollView only accepts StScrollable children; adding the
          // label directly warns and leaves the preview unable to scroll.
          // Wrap it in a St.BoxLayout, which implements StScrollable.
          this._textBox = new St.BoxLayout({
            style_class: 'spotlight-preview-text-box',
            orientation: vertical,
            x_expand: true,
          });
          this._textBox.add_child(this._officeHint);
          this._textBox.add_child(this._textLabel);

          this._textScroll = new St.ScrollView({
            style_class: 'spotlight-preview-scroll',
            x_expand: true,
            y_expand: true,
            visible: false,
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
          });
          this._textScroll.add_child(this._textBox);
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
            text: 'Akcje ⌃K',
            x_expand: true,
          });
          this._secondaryButton = new St.Button({
            style_class: 'spotlight-preview-button',
            x_expand: true,
            reactive: true,
            can_focus: true,
          });
          this._secondaryButton.set_child(this._secondaryLabel);
          this._buttons.add_child(this._secondaryButton);

          this._primaryButton.connect('clicked', () => {
            if (this._onPrimary)
              this._onPrimary();
          });
          this._secondaryButton.connect('clicked', () => {
            if (this._onActions)
              this._onActions();
          });
        }

        _replaceIcon(icon) {
          for (const child of this._iconBox.get_children())
            child.destroy();

          const props = {
            style_class: 'spotlight-preview-icon',
            icon_size: 44,
            ...iconProperties(icon),
          };

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

        _mergeRows(generated, existing) {
          const result = [];
          const seen = new Set();
          for (const row of [...generated, ...existing]) {
            if (!Array.isArray(row) || row.length < 2)
              continue;
            const label = stringValue(row[0]).trim();
            const value = stringValue(row[1]).trim();
            if (label === '' || value === '' || seen.has(label))
              continue;
            seen.add(label);
            result.push([label, value]);
            if (result.length >= MAX_ROWS)
              break;
          }
          return result;
        }

        _cancelTimeout() {
          if (!this._timeoutId)
            return;
          try {
            GLib.source_remove(this._timeoutId);
          } catch {
            // The source already fired.
          }
          this._timeoutId = 0;
        }

        _armTimeout(token, message, milliseconds = THUMBNAIL_TIMEOUT_MS) {
          this._cancelTimeout();
          this._timeoutId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            milliseconds,
            () => {
              this._timeoutId = 0;
              if (token === this._previewToken)
                this._showPlaceholder(message);
              return GLib.SOURCE_REMOVE;
            }
          );
        }

        _clearImage() {
          for (const child of this._imageBox.get_children())
            child.destroy();
          this._image = null;
          this._imageBox.hide();
        }

        _showPlaceholder(message) {
          if (this._destroyed)
            return;
          this._cancelTimeout();
          this._clearImage();
          this._textLabel.set_text(String(message ?? ''));
          this._textScroll.show();
          this.show();
        }

        _applyPixbuf(pixbuf, GdkPixbuf) {
          if (this._destroyed)
            return;
          try {
            const scaled = scalePixbuf(pixbuf, GdkPixbuf);
            const gicon = scaled ? pixbufToGicon(scaled) : null;
            if (!gicon) {
              this._showPlaceholder('Brak podglądu obrazu');
              return;
            }

            const width = scaled.get_width();
            const height = scaled.get_height();
            const iconSize = Math.max(
              1,
              Math.min(IMAGE_MAX_HEIGHT, Math.max(width, height))
            );
            this._cancelTimeout();
            this._clearImage();
            this._image = new St.Icon({
              style_class: 'spotlight-preview-image',
              gicon,
              icon_size: iconSize,
            });
            this._imageBox.set_child(this._image);
            this._imageBox.show();
            this._textLabel.set_text('');
            this._textScroll.hide();
            this._officeHint.hide();
            this.show();
          } catch (error) {
            reportError(error);
            this._showPlaceholder('Brak podglądu obrazu');
          }
        }

        _loadMetadata(path, token) {
          if (!path)
            return;

          let file;
          try {
            file = Gio.File.new_for_path(path);
          } catch {
            return;
          }

          file.query_info_async(
            'standard::size,time::modified',
            Gio.FileQueryInfoFlags.NONE,
            GLib.PRIORITY_DEFAULT,
            null,
            (source, result) => {
              if (this._destroyed || token !== this._metaToken)
                return;

              let info;
              try {
                info = source.query_info_finish(result);
              } catch {
                return;
              }

              let mtime = null;
              try {
                mtime = info.get_modification_date_time?.() ?? null;
              } catch {
                mtime = null;
              }

              const rows = formatMeta({
                size: info.get_size?.(),
                mtime,
                path,
              });
              const merged = this._mergeRows(rows, this._model?.rows ?? []);
              this._renderRows(merged);
              this._divider.visible = merged.length > 0 || Boolean(this._model?.kind);
            }
          );
        }

        _loadText(path, token, office) {
          let file;
          try {
            file = Gio.File.new_for_path(path);
          } catch {
            this._showPlaceholder('Nie można odczytać pliku');
            return;
          }

          this._armTimeout(token, 'Nie można odczytać pliku', TEXT_TIMEOUT_MS);

          try {
            // Always asynchronous: a file is never read synchronously from
            // this panel.
            file.load_contents_async(null, (source, result) => {
              if (this._destroyed || token !== this._previewToken)
                return;

              let data;
              try {
                const [ok, contents] = source.load_contents_finish(result);
                if (!ok)
                  throw new Error('load_contents_finish returned false');
                data = contents;
              } catch (error) {
                reportError(error);
                this._showPlaceholder('Nie można odczytać pliku');
                return;
              }

              if (token !== this._previewToken)
                return;

              this._cancelTimeout();
              const snippet = textSnippet(data, TEXT_PREVIEW_LINES);
              let text = snippet.text.replace(/\u0000/g, '');

              if (office) {
                this._officeHint.set_text(`Otwórz w aplikacji: ${path}`);
                this._officeHint.show();
                this._primaryLabel.set_text('Otwórz w aplikacji ⏎');
                if (text.trim() === '')
                  text = path;
              }

              this.setTextPreview(text);
            });
          } catch (error) {
            reportError(error);
            this._showPlaceholder('Nie można odczytać pliku');
          }
        }

        _schedulePixbufFallback(GdkPixbuf, path, size, token) {
          if (Number(size) > MAX_IMAGE_BYTES) {
            this._showPlaceholder('Obraz zbyt duży do podglądu');
            return;
          }

          let scheduled = false;
          try {
            scheduled = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
              if (this._destroyed || token !== this._previewToken)
                return GLib.SOURCE_REMOVE;

              let pixbuf = null;
              try {
                // Documented fallback for systems without the GNOME
                // thumbnail service. The file-size check above caps this at
                // 20 MB; the actual work runs from an idle callback.
                pixbuf = GdkPixbuf.Pixbuf.new_from_file_at_scale(
                  path,
                  IMAGE_MAX_WIDTH,
                  IMAGE_MAX_HEIGHT,
                  true
                );
              } catch (error) {
                reportError(error);
              }

              if (token !== this._previewToken)
                return GLib.SOURCE_REMOVE;

              if (pixbuf)
                this._applyPixbuf(pixbuf, GdkPixbuf);
              else
                this._showPlaceholder('Brak podglądu obrazu');
              return GLib.SOURCE_REMOVE;
            });
          } catch (error) {
            reportError(error);
            scheduled = false;
          }

          if (!scheduled)
            this._showPlaceholder('Brak podglądu obrazu');
        }

        _scheduleImageThumbnail(factory, GdkPixbuf, path, details, token) {
          let scheduled = false;
          try {
            scheduled = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
              if (this._destroyed || token !== this._previewToken)
                return GLib.SOURCE_REMOVE;

              let pixbuf = null;
              try {
                const uri = GLib.filename_to_uri(path, null);
                const thumbPath = factory.lookup(uri, details.mtime);
                if (thumbPath) {
                  pixbuf = GdkPixbuf.Pixbuf.new_from_file_at_scale(
                    thumbPath,
                    IMAGE_MAX_WIDTH,
                    IMAGE_MAX_HEIGHT,
                    true
                  );
                }

                if (!pixbuf && factory.can_thumbnail(
                  uri,
                  details.mime,
                  details.mtime
                )) {
                  // Thumbnail generation is intentionally run from idle: it
                  // may spawn a thumbnailer, so the typing path stays free.
                  pixbuf = factory.generate_thumbnail(
                    uri,
                    details.mime,
                    null
                  );
                }
              } catch (error) {
                reportError(error);
              }

              if (token !== this._previewToken)
                return GLib.SOURCE_REMOVE;

              if (pixbuf)
                this._applyPixbuf(pixbuf, GdkPixbuf);
              else
                this._schedulePixbufFallback(
                  GdkPixbuf,
                  path,
                  details.size,
                  token
                );
              return GLib.SOURCE_REMOVE;
            });
          } catch (error) {
            reportError(error);
            scheduled = false;
          }
          return scheduled;
        }

        async _startImagePreview(path, details, token) {
          try {
            const GdkPixbuf = await loadGdkPixbuf();
            if (this._destroyed || token !== this._previewToken)
              return;
            if (!GdkPixbuf) {
              this._showPlaceholder('Brak podglądu obrazu');
              return;
            }

            const GnomeDesktop = await loadGnomeDesktop();
            if (this._destroyed || token !== this._previewToken)
              return;

            const factory = getThumbnailFactory(GnomeDesktop);
            if (factory && this._scheduleImageThumbnail(
              factory,
              GdkPixbuf,
              path,
              details,
              token
            )) {
              return;
            }

            this._schedulePixbufFallback(
              GdkPixbuf,
              path,
              details.size,
              token
            );
          } catch (error) {
            reportError(error);
            if (!this._destroyed && token === this._previewToken)
              this._showPlaceholder('Brak podglądu obrazu');
          }
        }

        _loadImage(path, token) {
          this._armTimeout(token, 'Brak podglądu obrazu');

          let file;
          try {
            file = Gio.File.new_for_path(path);
          } catch {
            this._showPlaceholder('Brak podglądu obrazu');
            return;
          }

          file.query_info_async(
            'standard::size,time::modified,standard::content-type',
            Gio.FileQueryInfoFlags.NONE,
            GLib.PRIORITY_DEFAULT,
            null,
            (source, result) => {
              if (this._destroyed || token !== this._previewToken)
                return;

              let info = null;
              try {
                info = source.query_info_finish(result);
              } catch (error) {
                reportError(error);
              }

              let size = 0;
              let mtime = 0;
              try {
                size = Number(info?.get_size?.() ?? 0);
              } catch {
                size = 0;
              }
              try {
                mtime = Number(info?.get_modification_date_time?.()?.to_unix?.() ?? 0);
              } catch {
                mtime = 0;
              }

              this._startImagePreview(path, {
                size,
                mtime,
                mime: contentMimeType(path, info),
              }, token);
            }
          );
        }

        _schedulePdfThumbnail(factory, GdkPixbuf, path, details, token) {
          let scheduled = false;
          try {
            scheduled = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
              if (this._destroyed || token !== this._previewToken)
                return GLib.SOURCE_REMOVE;

              let pixbuf = null;
              try {
                const uri = GLib.filename_to_uri(path, null);
                const mime = details.mime || 'application/pdf';
                const thumbPath = factory.lookup(uri, details.mtime);
                if (thumbPath) {
                  pixbuf = GdkPixbuf.Pixbuf.new_from_file_at_scale(
                    thumbPath,
                    IMAGE_MAX_WIDTH,
                    IMAGE_MAX_HEIGHT,
                    true
                  );
                }

                if (!pixbuf && factory.can_thumbnail(
                  uri,
                  mime,
                  details.mtime
                )) {
                  pixbuf = factory.generate_thumbnail(uri, mime, null);
                }
              } catch (error) {
                reportError(error);
              }

              if (token !== this._previewToken)
                return GLib.SOURCE_REMOVE;

              if (pixbuf)
                this._applyPixbuf(pixbuf, GdkPixbuf);
              else
                this._showPlaceholder('brak podglądu PDF');
              return GLib.SOURCE_REMOVE;
            });
          } catch (error) {
            reportError(error);
            scheduled = false;
          }
          return scheduled;
        }

        async _startPdfPreview(path, details, token) {
          try {
            const [GnomeDesktop, GdkPixbuf] = await Promise.all([
              loadGnomeDesktop(),
              loadGdkPixbuf(),
            ]);
            if (this._destroyed || token !== this._previewToken)
              return;

            const factory = getThumbnailFactory(GnomeDesktop);
            if (!factory || !GdkPixbuf) {
              this._showPlaceholder('brak podglądu PDF');
              return;
            }

            if (!this._schedulePdfThumbnail(
              factory,
              GdkPixbuf,
              path,
              details,
              token
            )) {
              this._showPlaceholder('brak podglądu PDF');
            }
          } catch (error) {
            reportError(error);
            if (!this._destroyed && token === this._previewToken)
              this._showPlaceholder('brak podglądu PDF');
          }
        }

        _loadPdf(path, token) {
          this._armTimeout(token, 'brak podglądu PDF');

          let file;
          try {
            file = Gio.File.new_for_path(path);
          } catch {
            this._showPlaceholder('brak podglądu PDF');
            return;
          }

          file.query_info_async(
            'standard::size,time::modified,standard::content-type',
            Gio.FileQueryInfoFlags.NONE,
            GLib.PRIORITY_DEFAULT,
            null,
            (source, result) => {
              if (this._destroyed || token !== this._previewToken)
                return;

              let info = null;
              try {
                info = source.query_info_finish(result);
              } catch (error) {
                reportError(error);
              }

              let mtime = 0;
              try {
                mtime = Number(info?.get_modification_date_time?.()?.to_unix?.() ?? 0);
              } catch {
                mtime = 0;
              }

              this._startPdfPreview(path, {
                size: Number(info?.get_size?.() ?? 0),
                mtime,
                mime: contentMimeType(path, info) || 'application/pdf',
              }, token);
            }
          );
        }

        /**
         * Load a file preview asynchronously: image, first PDF page, text or
         * an office document. Unknown binaries show a short status row.
         *
         * @param {string} path
         */
        previewFile(path) {
          if (this._destroyed)
            return;

          const value = stringValue(path);
          if (value === '')
            return;

          const token = ++this._previewToken;
          this._cancelTimeout();
          this._clearImage();
          this._textLabel.set_text('');
          this._textScroll.hide();
          this._officeHint.set_text('');
          this._officeHint.hide();
          this._primaryLabel.set_text(this._model?.primary?.label || 'Otwórz ⏎');

          this._previewPath = value;
          this._previewKind = classify(value);
          this._previewOpen = true;

          if (this._previewKind === 'office') {
            this._officeHint.set_text(`Otwórz w aplikacji: ${value}`);
            this._officeHint.show();
            this._primaryLabel.set_text('Otwórz w aplikacji ⏎');
          }

          this.show();

          switch (this._previewKind) {
          case 'image':
            this._loadImage(value, token);
            break;
          case 'pdf':
            this._loadPdf(value, token);
            break;
          case 'text':
            this._loadText(value, token, false);
            break;
          case 'office':
            this._loadText(value, token, true);
            break;
          default:
            this._showPlaceholder('Brak podglądu pliku binarnego');
            break;
          }
        }

        closePreview() {
          this._previewToken++;
          this._cancelTimeout();
          this._clearImage();
          this._textLabel.set_text('');
          this._textScroll.hide();
          this._officeHint.set_text('');
          this._officeHint.hide();
          this._primaryLabel.set_text(this._model?.primary?.label || 'Otwórz ⏎');
          this._previewOpen = false;
        }

        isPreviewOpen() {
          return this._previewOpen;
        }

        /**
         * @param {object} model result of buildPreviewModel()
         * @param {{onPrimary?: Function, onSecondary?: Function, onActions?: Function}} [handlers]
         */
        setModel(model, handlers = {}) {
          if (!model)
            return;

          this._model = model;
          this._onPrimary = handlers.onPrimary ?? null;
          this._onSecondary = handlers.onSecondary ?? null;
          this._onActions = handlers.onActions ?? null;

          // A new selection invalidates any content loaded for the previous
          // result, but leaves an in-flight metadata query harmless.
          this._previewToken++;
          this._cancelTimeout();
          this._clearImage();
          this._textLabel.set_text('');
          this._textScroll.hide();
          this._officeHint.set_text('');
          this._officeHint.hide();
          this._previewOpen = false;
          this._previewPath = model.path || '';
          this._previewKind = classify(this._previewPath);
          const metaToken = ++this._metaToken;

          this._replaceIcon(model.icon);
          this._title.set_text(model.title || '');
          this._kind.set_text(model.kind || '');
          this._kind.visible = Boolean(model.kind);
          this._renderRows(model.rows);
          this._divider.visible = model.rows.length > 0 || Boolean(model.kind);

          const primaryLabel = model.primary?.label || 'Otwórz ⏎';
          this._primaryLabel.set_text(primaryLabel);
          this._secondaryLabel.set_text('Akcje ⌃K');

          this._primaryButton.reactive = Boolean(this._onPrimary);
          this._secondaryButton.reactive = true;
          if (this._onPrimary)
            this._primaryButton.remove_style_class_name('spotlight-preview-button-disabled');
          else
            this._primaryButton.add_style_class_name('spotlight-preview-button-disabled');
          if (this._onActions)
            this._secondaryButton.remove_style_class_name('spotlight-preview-button-disabled');
          else
            this._secondaryButton.add_style_class_name('spotlight-preview-button-disabled');

          if (this._previewPath)
            this._loadMetadata(this._previewPath, metaToken);

          this.show();
        }

        /**
         * Show a scrollable text excerpt below the metadata table.
         *
         * @param {string} text
         */
        setTextPreview(text) {
          this._cancelTimeout();
          this._clearImage();
          this._textLabel.set_text(String(text ?? ''));
          this._textScroll.show();
          this._previewOpen = true;
          this.show();
        }

        clear() {
          this._model = null;
          this._onPrimary = null;
          this._onSecondary = null;
          this._onActions = null;
          this._previewToken++;
          this._metaToken++;
          this._cancelTimeout();
          this._clearImage();
          this._clearRows();
          this._textLabel.set_text('');
          this._textScroll.hide();
          this._officeHint.set_text('');
          this._officeHint.hide();
          this._previewPath = '';
          this._previewKind = '';
          this._previewOpen = false;
          this.hide();
        }

        destroy() {
          this._destroyed = true;
          this._previewToken++;
          this._metaToken++;
          this._cancelTimeout();
          super.destroy();
        }
      }
    );
  }

  return new PreviewPanelClass();
}

export { PREVIEW_WIDTH, MAX_ROWS, MAX_ROWS as PREVIEW_MAX_ROWS };
export { IMAGE_MAX_HEIGHT, MAX_IMAGE_BYTES };
export const buildRows = buildPreviewRows;
export const buildModel = buildPreviewModel;

export default {
  buildPreviewRows,
  buildPreviewModel,
  createPreviewPanel,
  PREVIEW_WIDTH,
  PREVIEW_MAX_ROWS: MAX_ROWS,
  IMAGE_MAX_HEIGHT,
  MAX_IMAGE_BYTES,
};