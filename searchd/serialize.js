// PURE helpers shared by the D-Bus entry point and the SearchProvider2 adapter.

const ACTION_FIELDS = [
  'id', 'label', 'type', 'command', 'path', 'appId', 'desktopFile', 'text',
];

function encodeAction(action) {
  if (!action)
    return null;

  if (typeof action === 'function') {
    return {
      id: action.name || 'action',
      label: action.name || 'Akcja',
      disabled: false,
    };
  }

  if (typeof action !== 'object')
    return null;

  const encoded = {};
  for (const field of ACTION_FIELDS) {
    if (action[field] !== undefined && action[field] !== null)
      encoded[field] = action[field];
  }
  if (Object.keys(encoded).length === 0)
    return null;

  if (action.disabled === true)
    encoded.disabled = true;

  return encoded;
}

/**
 * Turn the internal action object (functions in Shell providers, descriptors
 * in daemon providers) into a JSON-safe description for D-Bus clients.
 *
 * @param {*} actions
 * @returns {string}
 */
export function serializeActions(actions) {
  if (!actions || typeof actions !== 'object')
    return '{}';

  const menu = Array.isArray(actions.menu)
    ? actions.menu.map(encodeAction).filter(Boolean)
    : [];

  return JSON.stringify({
    primary: encodeAction(actions.primary),
    secondary: encodeAction(actions.secondary),
    menu,
  });
}

/**
 * Serialize a GIcon (or an icon name) to the string form SearchProvider2
 * expects in its `gicon` metadata field.
 *
 * @param {*} icon
 * @param {string} [fallback]
 * @returns {string}
 */
export function iconToString(icon, fallback = 'application-x-executable-symbolic') {
  if (typeof icon === 'string')
    return icon;
  if (icon && typeof icon.to_string === 'function') {
    try {
      return String(icon.to_string());
    } catch {
      return fallback;
    }
  }
  return fallback;
}

export function resultPath(result) {
  if (!result || typeof result !== 'object')
    return '';
  return String(result.path ?? result.preview?.path ?? result.activation?.path ?? '');
}

export function resultDescription(result) {
  if (!result || typeof result !== 'object')
    return '';
  return String(result.description ?? result.subtitle ?? '');
}