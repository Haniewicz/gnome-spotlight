// PURE module: no GI or shell-resource imports.
//
// Helpers for the `systemctl --user` / user-manager units shown by the
// commands provider.

const DEFAULT_LIMIT = 8;

const VERB_LABELS = Object.freeze({
  start: 'Uruchom',
  stop: 'Zatrzymaj',
  restart: 'Restartuj',
  status: 'Status',
});

function unitName(unit) {
  return String(unit?.Name ?? unit?.name ?? '').trim();
}

function unitDescription(unit) {
  return String(unit?.Description ?? unit?.description ?? '').trim();
}

function compareNames(a, b) {
  const left = unitName(a).toLocaleLowerCase();
  const right = unitName(b).toLocaleLowerCase();
  if (left < right)
    return -1;
  if (left > right)
    return 1;
  return unitName(a).localeCompare(unitName(b), 'pl');
}

/**
 * Filter units by a case-insensitive substring of Name or Description, drop
 * duplicate names and return at most eight entries sorted by name.
 *
 * @param {object[]} units
 * @param {string} query
 * @returns {object[]}
 */
export function rankUnits(units, query) {
  if (!Array.isArray(units))
    return [];

  const needle = String(query ?? '').trim().toLocaleLowerCase();
  const seen = new Set();
  const matched = [];

  for (const unit of units) {
    if (!unit || typeof unit !== 'object')
      continue;

    const name = unitName(unit);
    if (name === '')
      continue;

    const key = name.toLocaleLowerCase();
    if (seen.has(key))
      continue;

    if (needle !== '') {
      const searchable = `${name}\n${unitDescription(unit)}`.toLocaleLowerCase();
      if (!searchable.includes(needle))
        continue;
    }

    seen.add(key);
    matched.push(unit);
  }

  matched.sort(compareNames);
  return matched.slice(0, DEFAULT_LIMIT);
}

/**
 * Describe one systemctl --user action. The argv array is passed directly to
 * a process launcher; it never goes through a shell.
 *
 * @param {object} unit
 * @param {'start'|'stop'|'restart'|'status'} verb
 * @returns {{label: string, argv: string[]}|null}
 */
export function formatUnitAction(unit, verb) {
  const name = unitName(unit);
  const action = String(verb ?? '');
  if (name === '' || !Object.prototype.hasOwnProperty.call(VERB_LABELS, action))
    return null;

  return {
    label: `${VERB_LABELS[action]} ${name}`,
    argv: ['systemctl', '--user', action, name],
  };
}

export default rankUnits;
