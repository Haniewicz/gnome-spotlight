// PURE module: no GI or shell-resource imports.
import { fold } from './text.js';

/**
 * Fold a target string while remembering, for every resulting UTF-16 code
 * unit, the index of the original code point it came from. This keeps
 * returned positions relative to the ORIGINAL string even when folding
 * expands a character (e.g. ß -> ss).
 *
 * @param {*} text
 * @returns {{folded: string, map: number[]}}
 */
function foldWithMap(text) {
  let folded = '';
  const map = [];
  let offset = 0;

  for (const ch of String(text ?? '')) {
    const piece = fold(ch);
    for (let i = 0; i < piece.length; i++) {
      folded += piece[i];
      map.push(offset);
    }
    offset += ch.length;
  }

  return { folded, map };
}

/**
 * Subsequence matching after folding. Matching is case- and
 * diacritic-insensitive; returned positions point into the original target.
 *
 * @param {*} query
 * @param {*} target
 * @returns {{matched: boolean, positions: number[], runs: number, span: number}}
 */
export function matchPositions(query, target) {
  const needle = fold(query);
  const miss = { matched: false, positions: [], runs: 0, span: 0 };

  if (needle.length === 0)
    return miss;

  const { folded: haystack, map } = foldWithMap(target);
  if (haystack.length === 0)
    return miss;

  const matchedIndices = [];
  let from = 0;

  // Iterate by UTF-16 code unit so positions.length always equals the
  // folded query length (the contract used by the ranking tests).
  for (let i = 0; i < needle.length; i++) {
    const index = haystack.indexOf(needle[i], from);
    if (index === -1)
      return miss;

    matchedIndices.push(index);
    from = index + 1;
  }

  const positions = matchedIndices.map(index => map[index]);

  let runs = 1;
  for (let i = 1; i < matchedIndices.length; i++) {
    if (matchedIndices[i] !== matchedIndices[i - 1] + 1)
      runs++;
  }

  const span = matchedIndices[matchedIndices.length - 1] - matchedIndices[0] + 1;

  return {
    matched: true,
    positions,
    runs,
    span,
  };
}