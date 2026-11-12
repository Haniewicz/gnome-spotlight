// PURE module: no GI or shell-resource imports.
//
// Snippet store parser. snippets.json is a user-edited file, so every
// malformed shape degrades to a valid (possibly empty) list instead of
// throwing inside the launcher.

function entryList(parsed) {
  if (Array.isArray(parsed))
    return parsed;

  if (parsed && typeof parsed === 'object') {
    if (Array.isArray(parsed.snippets))
      return parsed.snippets;

    // Also accept the convenient map form:
    // { "sig": { "name": "...", "text": "..." } } or { "sig": "text" }.
    return Object.entries(parsed).map(([keyword, value]) => {
      if (typeof value === 'string')
        return { keyword, text: value };
      if (value && typeof value === 'object')
        return { ...value, keyword: value.keyword ?? keyword };
      return null;
    });
  }

  return [];
}

function normalizeEntry(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    return null;

  const text = raw.text;
  if (typeof text !== 'string' || text.trim() === '')
    return null;

  const keyword = String(raw.keyword ?? '').trim();
  if (keyword === '')
    return null;
  // A keyword is a single trigger token; whitespace inside it makes the
  // trigger ambiguous, so such entries are ignored.
  if (/\s/.test(keyword))
    return null;

  const name = String(raw.name ?? raw.title ?? '').trim();
  return {
    keyword,
    name: name === '' ? keyword : name,
    text,
  };
}

/**
 * Parse snippets.json. Broken JSON, non-array roots and incomplete entries
 * are ignored; one bad entry never hides the healthy ones.
 *
 * @param {string|object|array} json serialized or already parsed contents
 * @returns {{keyword: string, name: string, text: string}[]}
 */
export function parseSnippets(json) {
  let parsed = json;

  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return [];
    }
  }

  const result = [];
  const seen = new Set();
  for (const raw of entryList(parsed)) {
    const entry = normalizeEntry(raw);
    if (!entry || seen.has(entry.keyword))
      continue;
    seen.add(entry.keyword);
    result.push(entry);
  }
  return result;
}

export default parseSnippets;
