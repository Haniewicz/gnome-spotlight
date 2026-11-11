const CALLBACK_KEYS = ['callback', 'action', 'activate', 'onActivate', 'run', 'handler'];

function firstFunction(item) {
  for (const key of CALLBACK_KEYS) {
    if (typeof item?.[key] === 'function')
      return item[key];
  }
  return null;
}

function itemLabel(item) {
  if (typeof item === 'string')
    return item.trim();
  if (typeof item === 'function')
    return String(item.label ?? item.title ?? '').trim();
  return String(item?.label ?? item?.title ?? '').trim();
}

/**
 * Build the action-menu model from `result.actions.menu`.
 *
 * The model preserves provider order. An item is disabled when it has no
 * executable callback, sets `disabled: true` or `enabled: false`, or when the
 * whole result is disabled. An empty/missing list means "no menu".
 *
 * @param {object|null|undefined} result
 * @returns {{id: string, label: string, disabled: boolean, callback: Function|null, icon: *, shortcut: string}[]}
 */
export function buildActionMenu(result) {
  if (!result || result.disabled)
    return [];

  const menu = result.actions?.menu;
  if (!Array.isArray(menu) || menu.length === 0)
    return [];

  const items = [];
  for (let index = 0; index < menu.length; index++) {
    const entry = menu[index];
    if (entry === null || entry === undefined)
      continue;

    if (typeof entry !== 'object' && typeof entry !== 'function' && typeof entry !== 'string')
      continue;

    const label = itemLabel(entry);
    if (label === '')
      continue;

    const callback = typeof entry === 'object' ? firstFunction(entry) : null;
    const disabled = Boolean(
      (typeof entry === 'object' && (entry.disabled === true || entry.enabled === false)) ||
      typeof callback !== 'function'
    );

    items.push({
      id: String(entry?.id ?? `action-${index}`),
      label,
      disabled,
      callback,
      icon: typeof entry === 'object' ? entry.icon ?? null : null,
      shortcut: typeof entry === 'object' ? String(entry.shortcut ?? '') : '',
    });
  }

  return items;
}

export const normalizeMenuActions = buildActionMenu;
export const buildMenuModel = buildActionMenu;

/**
 * Create a PopupMenu populated from an action-menu model. GI modules are
 * injected to keep the model helpers testable in plain gjs.
 *
 * @param {object} PopupMenu module resource:///org/gnome/shell/ui/popupMenu.js
 * @param {object} St
 * @param {object} sourceActor
 * @param {object[]} items result of buildActionMenu()
 * @param {Function} [onActivate] called as onActivate(item)
 * @returns {{menu: object, popupItems: object[]}|null}
 */
export function createPopupActionMenu(PopupMenu, St, sourceActor, items, onActivate = null) {
  if (!Array.isArray(items) || items.length === 0)
    return null;

  const menu = new PopupMenu.PopupMenu(sourceActor, 0.0, St.Side.TOP);
  if (menu.box)
    menu.box.add_style_class_name('spotlight-action-menu');

  const popupItems = [];
  for (const item of items) {
    const popupItem = new PopupMenu.PopupMenuItem(item.label);
    if (item.disabled) {
      popupItem.setSensitive(false);
    } else {
      popupItem.connect('activate', () => {
        try {
          onActivate?.(item);
        } catch (error) {
          logError(error);
        }
      });
    }
    menu.addMenuItem(popupItem);
    popupItems.push(popupItem);
  }

  return { menu, popupItems };
}

export default buildActionMenu;