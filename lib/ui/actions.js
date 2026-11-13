import { parseActions } from '../action-runner.js';

const CALLBACK_KEYS = ['callback', 'action', 'activate', 'onActivate', 'run', 'handler'];
const ESCAPE_KEY_SYMBOL = 0xff1b;

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

function hasDescriptorType(entry) {
  return typeof entry === 'object' && entry !== null &&
    String(entry.type ?? '').trim() !== '';
}

/**
 * Build the action-menu model from the result's parsed actions.
 *
 * The model preserves provider order. An item is disabled only when it sets
 * `disabled: true`, `enabled: false`, or when the whole result is disabled.
 * Declarative descriptors without an in-process callback stay actionable;
 * the modal executes them through `runAction()`. Plain callback entries from
 * in-process providers keep working and expose their callback as well as a
 * descriptor when they carry a declarative `type`.
 *
 * @param {object|null|undefined} result
 * @param {{parse?: Function}|Function} [options] optional parser override
 * @returns {{id: string, label: string, disabled: boolean, descriptor: object|null, callback: Function|null, icon: *, shortcut: string}[]}
 */
export function buildActionMenu(result, options = {}) {
  if (!result || result.disabled)
    return [];

  const parser = typeof options === 'function' ? options : options?.parse;
  let actions = null;
  try {
    actions = typeof parser === 'function' ? parser(result) : parseActions(result);
  } catch {
    actions = null;
  }

  const menu = Array.isArray(actions) ? actions : actions?.menu;
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

    const callback = typeof entry === 'function'
      ? entry
      : (typeof entry === 'object' ? firstFunction(entry) : null);
    const disabled = Boolean(
      typeof entry === 'object' && entry !== null &&
      (entry.disabled === true || entry.enabled === false)
    );
    const descriptor = typeof entry === 'object' && entry !== null &&
      (callback === null || hasDescriptorType(entry))
      ? entry
      : null;

    items.push({
      id: String(entry?.id ?? `action-${index}`),
      label,
      disabled,
      descriptor,
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
 * Consume Escape inside an action popup.
 *
 * The popup is a sibling of the modal in `Main.uiGroup`, so returning `true`
 * here keeps the key event from reaching the modal's captured-event handler:
 * Escape closes only the menu, never the launcher.
 *
 * @param {object} menu PopupMenu.PopupMenu
 * @param {object} event Clutter key event
 * @returns {boolean} true when the event was handled
 */
export function handleActionMenuKeyPress(menu, event) {
  let symbol = 0;
  try {
    symbol = event?.get_key_symbol?.() ?? 0;
  } catch {
    return false;
  }

  if (symbol !== ESCAPE_KEY_SYMBOL)
    return false;

  try {
    menu?.close?.({ animate: false });
  } catch {
    try {
      menu?.close?.();
    } catch {
      // The menu may already be destroyed.
    }
  }
  return true;
}

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

  if (typeof menu.actor?.connect === 'function') {
    menu.actor.connect('key-press-event', (_actor, event) =>
      handleActionMenuKeyPress(menu, event));
  }

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