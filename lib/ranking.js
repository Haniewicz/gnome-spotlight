// PURE module: no GI or shell-resource imports.
import { fold } from './text.js';
import { matchPositions } from './fuzzy.js';

const WORD_SEPARATORS = /[\s\-_/.,:;!?()[\]{}'"@+&|\\—–·]/;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

function isWordStart(text, index) {
  if (index <= 0)
    return true;
  return WORD_SEPARATORS.test(text[index - 1]);
}

/**
 * Base fuzzy score for one target string, without frecency.
 * Returns 0 when the query is not a subsequence of the target.
 *
 * @param {string} query already-trimmed query
 * @param {*} target
 * @returns {number}
 */
function matchScore(query, target) {
  const needle = fold(query);
  const haystack = fold(target);

  if (needle.length === 0 || haystack.length === 0)
    return 0;

  const match = matchPositions(needle, haystack);
  if (!match.matched)
    return 0;

  let base;
  if (haystack === needle)
    base = 1000;
  else if (haystack.startsWith(needle))
    base = 700;
  else if (isWordStart(haystack, match.positions[0]))
    base = 400;
  else if (haystack.includes(needle))
    base = 250;
  else
    base = 120;

  return base + 20 * match.runs - Math.min(match.span, 200) * 0.5;
}

function usageCount(usageEntry) {
  if (usageEntry === null || usageEntry === undefined)
    return 0;

  if (typeof usageEntry === 'number')
    return Number.isFinite(usageEntry) ? Math.max(0, usageEntry) : 0;

  const count = Number(usageEntry.count);
  return Number.isFinite(count) ? Math.max(0, count) : 0;
}

function usageRecencyBoost(usageEntry, nowMs) {
  if (!usageEntry || typeof usageEntry !== 'object')
    return 0;

  const lastUsed = Number(usageEntry.lastUsed);
  if (!Number.isFinite(lastUsed) || lastUsed <= 0)
    return 0;

  const age = nowMs - lastUsed;
  if (age < 0)
    return 0;
  if (age < HOUR_MS)
    return 40;
  if (age < DAY_MS)
    return 20;
  if (age < WEEK_MS)
    return 10;
  return 0;
}

function usageBoost(usageEntry, nowMs) {
  return Math.min(usageCount(usageEntry), 50) * 2 + usageRecencyBoost(usageEntry, nowMs);
}

function usageKeys(result) {
  const keys = [];
  if (result.usageKey)
    keys.push(String(result.usageKey));
  if (result.providerId && result.id !== undefined)
    keys.push(`${result.providerId}:${result.id}`);
  if (result.id !== undefined && result.id !== null)
    keys.push(String(result.id));
  if (result.title)
    keys.push(String(result.title));
  return keys;
}

function getUsageEntry(usageMap, result) {
  if (!usageMap || !result)
    return null;

  if (typeof usageMap.entry === 'function') {
    for (const key of usageKeys(result)) {
      try {
        const entry = usageMap.entry(key);
        if (entry && (Number(entry.count) > 0 || Number(entry.lastUsed) > 0))
          return entry;
      } catch {
        // A malformed store must never break ranking.
      }
    }
  }

  if (typeof usageMap.get === 'function') {
    for (const key of usageKeys(result)) {
      try {
        const entry = usageMap.get(key);
        if (entry !== undefined && entry !== null)
          return entry;
      } catch {
        // Ignore broken map implementations.
      }
    }
  }

  for (const key of usageKeys(result)) {
    if (Object.prototype.hasOwnProperty.call(usageMap, key))
      return usageMap[key];
  }

  return null;
}

/**
 * Score a single result.
 *
 * @param {string} query
 * @param {object} result
 * @param {{count?: number, lastUsed?: number}|number|null} [usageEntry]
 * @param {number} [nowMs] injectable clock for deterministic tests
 * @returns {number}
 */
export function scoreResult(query, result, usageEntry = null, nowMs = Date.now()) {
  if (!result)
    return 0;

  const needle = String(query ?? '').trim();
  if (needle.length === 0)
    return 0;

  const titleScore = matchScore(needle, result.title ?? '');
  const keyValue = result.key ?? result.title ?? '';
  const keyScore = String(keyValue) === String(result.title ?? '')
    ? titleScore
    : matchScore(needle, keyValue);

  // Matching the key carries no penalty (DESIGN §5), while the title is
  // always scored at full weight. Taking the maximum handles both.
  const base = Math.max(titleScore, keyScore);
  if (base <= 0)
    return 0;

  return base + usageBoost(usageEntry, nowMs);
}

/**
 * Rank results without mutating the input array (or its objects).
 * Sort order: score desc, usage desc, title asc using Polish collation.
 *
 * @param {string} query
 * @param {object[]} results
 * @param {object|Map|{entry: Function}} [usageMap]
 * @returns {object[]}
 */
export function rankResults(query, results, usageMap = null) {
  if (!Array.isArray(results))
    return [];

  const nowMs = Date.now();
  const ranked = results.map((result, index) => {
    const usageEntry = getUsageEntry(usageMap, result);
    return {
      result,
      index,
      score: scoreResult(query, result, usageEntry, nowMs),
      usage: usageCount(usageEntry),
    };
  });

  ranked.sort((a, b) => {
    if (b.score !== a.score)
      return b.score - a.score;
    if (b.usage !== a.usage)
      return b.usage - a.usage;

    const titleOrder = String(a.result?.title ?? '')
      .localeCompare(String(b.result?.title ?? ''), 'pl');
    if (titleOrder !== 0)
      return titleOrder;

    // Explicit stable fallback for engines without stable Array#sort.
    return a.index - b.index;
  });

  return ranked.map(entry => entry.result);
}