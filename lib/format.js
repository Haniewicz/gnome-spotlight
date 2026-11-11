// PURE module: no GI or shell-resource imports.

const ELLIPSIS = '…';
const SIZE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];

function normalizeSpaces(text) {
  // ICU uses NBSP (and sometimes a narrow NBSP) as the pl-PL grouping
  // separator. Normalizing it keeps displays and tests deterministic.
  return String(text).replace(/[\u00a0\u202f]/g, ' ');
}

/**
 * Format a number using Intl when available, with a deterministic fallback.
 *
 * @param {*} n
 * @param {string} [locale]
 * @returns {string}
 */
export function formatNumber(n, locale = 'pl-PL') {
  if (n === null || n === undefined || n === '')
    return '';

  let value = Number(n);
  if (!Number.isFinite(value) && typeof n === 'string')
    value = Number(n.replace(',', '.'));
  if (!Number.isFinite(value))
    return '';

  // Avoid the surprising "-0" output for tiny negative values.
  const normalized = Object.is(value, -0) ? 0 : value;

  try {
    if (typeof Intl === 'object' && typeof Intl.NumberFormat === 'function') {
      const formatter = new Intl.NumberFormat(locale, {
        useGrouping: true,
        maximumFractionDigits: 10,
      });
      return normalizeSpaces(formatter.format(normalized));
    }
  } catch {
    // Fall through to the manual formatter.
  }

  const negative = normalized < 0;
  const text = String(Math.abs(normalized));
  let [integer, fraction = ''] = text.split('.');

  if (integer.length > 3)
    integer = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

  fraction = fraction.replace(/0+$/, '');
  const sign = negative ? '-' : '';
  return fraction ? `${sign}${integer},${fraction}` : `${sign}${integer}`;
}

/**
 * Human readable file size. The labels are the usual KB/MB/GB names but the
 * divisor is 1024 (KiB semantics), matching what file managers display.
 *
 * @param {*} bytes
 * @returns {string}
 */
export function humanSize(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value))
    return '0 B';

  const negative = value < 0;
  let size = Math.abs(value);
  const sign = negative ? '-' : '';

  if (size < 1024)
    return `${sign}${Math.round(size)} B`;

  let unit = 0;
  while (size >= 1024 && unit < SIZE_UNITS.length - 1) {
    size /= 1024;
    unit++;
  }

  // Keep one decimal below 100, whole numbers above it.
  const rounded = size >= 100 ? Math.round(size) : Math.round(size * 10) / 10;
  return `${sign}${formatNumber(rounded)} ${SIZE_UNITS[unit]}`;
}

function normalizeHome(homeDir) {
  let home = String(homeDir ?? '');
  if (home === '/' || home === '')
    return '';
  home = home.replace(/\/+$/, '');
  return home;
}

/**
 * Replace the user's home prefix with "~" and shorten long paths in the
 * middle, preserving both the beginning and the file name.
 *
 * @param {*} path
 * @param {*} [homeDir]
 * @param {number} [maxLen] default 60
 * @returns {string}
 */
export function shortenPath(path, homeDir = '', maxLen = 60) {
  let value = String(path ?? '');
  if (value === '')
    return '';

  const home = normalizeHome(homeDir);
  if (home && (value === home || value === `${home}/`))
    value = '~';
  else if (home && value.startsWith(`${home}/`))
    value = `~${value.slice(home.length)}`;

  const limit = Number(maxLen);
  const max = Number.isFinite(limit) ? Math.floor(limit) : 60;
  if (max <= 0)
    return '';
  if (value.length <= max)
    return value;
  if (max === 1)
    return ELLIPSIS;

  const base = value.slice(value.lastIndexOf('/') + 1);
  const budget = max - 1;

  // Preferred form: keep the path prefix and the complete basename.
  if (base.length <= budget) {
    const prefixBudget = budget - base.length;
    if (prefixBudget > 0) {
      let prefix = value.slice(0, prefixBudget);
      const slash = prefix.lastIndexOf('/');
      // Align to the last directory boundary, including the "~/" boundary at
      // index 1. A prefix must never end in the middle of a directory name.
      if (slash >= 1)
        prefix = prefix.slice(0, slash + 1);
      return `${prefix}${ELLIPSIS}${base}`;
    }
  }

  // The basename alone is too long: cut both ends.
  const headLen = Math.max(1, Math.ceil(budget * 0.6));
  const tailLen = Math.max(0, budget - headLen);
  const head = value.slice(0, headLen);
  const tail = tailLen > 0 ? value.slice(value.length - tailLen) : '';
  return `${head}${ELLIPSIS}${tail}`;
}

export default { shortenPath, humanSize, formatNumber };