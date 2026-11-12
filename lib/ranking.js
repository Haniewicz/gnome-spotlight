// PURE module: no GI or shell-resource imports.
import { fold } from './text.js';
import { matchPositions } from './fuzzy.js';

const WORD_SEPARATORS = /[\s\-_/.,:;!?()[\]{}'"@+&|\\—–·]/;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

// The basename is the strongest signal in a path. Directory names still count,
// but only at 60% of the same match quality: a file named "DESIGN.md" must
// outrank a file that merely lives in a "design" folder.
const DIRECTORY_MATCH_WEIGHT = 0.6;
// A match in the first segment below $HOME is a useful relevance signal:
// ~/Projekty/... is usually more interesting than ~/BottlesShare/drive_c/... .
const HOME_SEGMENT_BONUS = 60;
const DEPTH_PENALTY = 4;
const MAX_DEPTH = 12;
// Only breaks an otherwise exact tie; it is deliberately too small to change
// anything but near-identical path scores.
const PATH_LENGTH_TIE_WEIGHT = 0.0001;

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

function stripTrailingSlash(value) {
  const text = String(value ?? '');
  if (text.length <= 1)
    return text;
  return text.replace(/\/+$/, '');
}

function relativeToHome(path, homeDir) {
  const home = stripTrailingSlash(homeDir);
  if (!home)
    return null;
  if (path === home)
    return '';
  if (path.startsWith(`${home}/`))
    return path.slice(home.length + 1);
  return null;
}

function pathSegments(path) {
  return String(path ?? '').split('/').filter(Boolean);
}

function depthOf(path, homeDir) {
  const relative = relativeToHome(path, homeDir);
  if (relative !== null) {
    // The separator directly after $HOME counts too: ~/Projekty/file has a
    // depth of 2 separators.
    if (relative === '')
      return 0;
    return (relative.match(/\//g) ?? []).length + 1;
  }
  // Outside $HOME the absolute path still has a cost: one separator per
  // directory below the filesystem root.
  return Math.max(0, pathSegments(path).length - 1);
}

/**
 * Score how well a query matches a filesystem path.
 *
 * Contract:
 * - a basename match counts at full weight (the same match score as a title),
 * - a directory match counts at 60% of that weight,
 * - the first directory below $HOME earns a small relevance bonus,
 * - every separator below $HOME costs 4 points, capped at 12 levels,
 * - on an otherwise exact tie the shorter path wins.
 *
 * Returns 0 when neither the basename nor any directory matches, so callers
 * can add the result to another score without turning non-matches negative.
 *
 * @param {string} query
 * @param {{path?: string, homeDir?: string, depth?: number}} [options]
 * @returns {number}
 */
export function scorePathMatch(query, options = {}) {
  const settings = options && typeof options === 'object' ? options : {};
  const needle = String(query ?? '').trim();
  const path = stripTrailingSlash(settings.path);
  if (needle === '' || path === '')
    return 0;

  const homeDir = stripTrailingSlash(settings.homeDir);
  const relative = relativeToHome(path, homeDir);
  const segments = relative !== null
    ? relative.split('/').filter(Boolean)
    : pathSegments(path);
  if (segments.length === 0)
    return 0;

  const basename = segments[segments.length - 1];
  const basenameScore = matchScore(needle, basename);

  let directoryScore = 0;
  for (const segment of segments.slice(0, -1)) {
    directoryScore = Math.max(
      directoryScore,
      matchScore(needle, segment) * DIRECTORY_MATCH_WEIGHT
    );
  }

  let score = Math.max(basenameScore, directoryScore);
  if (score <= 0)
    return 0;

  // Prefer a project folder directly below $HOME over the same name buried in
  // an emulated Windows tree. The bonus applies once, to the top-level segment.
  if (relative !== null && segments.length > 1) {
    const topLevel = segments[0];
    if (topLevel !== basename && matchScore(needle, topLevel) > 0)
      score += HOME_SEGMENT_BONUS;
  }

  const requestedDepth = Number(settings.depth);
  const depth = Number.isFinite(requestedDepth) && requestedDepth >= 0
    ? Math.floor(requestedDepth)
    : depthOf(path, homeDir);
  score -= DEPTH_PENALTY * Math.min(depth, MAX_DEPTH);

  // Tiny, monotonic tie-breaker: shorter paths sort first when every other
  // component (including depth) is identical.
  score -= path.length * PATH_LENGTH_TIE_WEIGHT;

  return Math.max(0, score);
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