// PURE module: no GI or shell-resource imports.

// Characters that are not decomposed by Unicode NFD, or whose compatibility
// decomposition is not useful for search. Keys are lowercase.
const SPECIAL_FOLDS = {
  'ß': 'ss',
  'æ': 'ae',
  'œ': 'oe',
  'ø': 'o',
  'đ': 'd',
  'ð': 'd',
  'þ': 'th',
  'ł': 'l',
  'ħ': 'h',
  'ı': 'i',
  'ŧ': 't',
  'ĸ': 'k',
  'ŋ': 'n',
};

/**
 * Fold text for accent-insensitive, case-insensitive matching.
 * Polish diacritics (ą ć ę ł ń ó ś ź ż) and common Latin diacritics
 * (ä ö ü ß, accents, etc.) are reduced to their ASCII base letters.
 *
 * @param {*} text
 * @returns {string}
 */
export function fold(text) {
  if (text === null || text === undefined)
    return '';

  let value = String(text).toLowerCase();

  // Replace characters that do not have a useful NFD decomposition first.
  for (const [from, to] of Object.entries(SPECIAL_FOLDS))
    value = value.split(from).join(to);

  // NFD turns most accented letters into base letter + combining mark.
  if (typeof value.normalize === 'function')
    value = value.normalize('NFD').replace(/[\u0300-\u036f]/g, '');

  return value;
}

/**
 * Normalize a query/title for comparison: fold diacritics, collapse
 * whitespace and trim the ends.
 *
 * @param {*} text
 * @returns {string}
 */
export function normalize(text) {
  return fold(text).replace(/\s+/g, ' ').trim();
}