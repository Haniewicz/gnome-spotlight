// PURE module: no GI or shell-resource imports.
//
// Minimal parser for the OpenSSH client configuration. It only extracts the
// Host blocks that can be offered as launcher actions; Include expansion,
// canonicalisation and pattern matching are deliberately out of scope.

const DEFAULT_PORT = 22;

function tokenize(line) {
  const tokens = [];
  let current = '';
  let quote = '';
  let escaped = false;

  for (let index = 0; index < line.length; index++) {
    const character = line[index];

    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }

    if (quote !== '') {
      if (character === '\\') {
        escaped = true;
        continue;
      }
      if (character === quote) {
        quote = '';
        continue;
      }
      current += character;
      continue;
    }

    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }

    if (character === '\\') {
      escaped = true;
      continue;
    }

    // A '#' starts a comment only at the beginning of a token. Inside a value
    // it is a literal character ("Host foo#bar" is still a valid pattern).
    if (character === '#' && current === '') {
      break;
    }

    if (character === ' ' || character === '\t' || character === '=') {
      if (current !== '') {
        tokens.push(current);
        current = '';
      }
      continue;
    }

    current += character;
  }

  if (current !== '')
    tokens.push(current);
  return tokens;
}

function isUsableAlias(alias) {
  const value = String(alias ?? '').trim();
  if (value === '' || value.startsWith('!') || value.startsWith('#'))
    return false;
  // Wildcard/negated Host patterns are not concrete connectable hosts.
  return !/[*?[\]]/.test(value);
}

function parsePort(value) {
  const number = Number.parseInt(String(value ?? '').trim(), 10);
  if (!Number.isFinite(number) || number < 1 || number > 65535)
    return null;
  return number;
}

/**
 * Parse an SSH client config into concrete aliases.
 *
 * @param {string} text contents of ~/.ssh/config
 * @returns {{alias: string, hostName: string, user: string, port: number}[]}
 */
export function parseSshConfig(text) {
  const source = String(text ?? '').replace(/^\uFEFF/, '');
  const entries = new Map();
  let aliases = [];
  let active = false;

  const ensureEntry = alias => {
    let entry = entries.get(alias);
    if (!entry) {
      entry = {
        alias,
        hostName: alias,
        user: '',
        port: DEFAULT_PORT,
      };
      entries.set(alias, entry);
    }
    return entry;
  };

  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#'))
      continue;

    const tokens = tokenize(line);
    if (tokens.length === 0)
      continue;

    const keyword = tokens[0].toLowerCase();

    if (keyword === 'host') {
      aliases = tokens.slice(1).filter(isUsableAlias);
      active = aliases.length > 0;
      for (const alias of aliases)
        ensureEntry(alias);
      continue;
    }

    if (keyword === 'match') {
      // Everything below Match is conditional; stop assigning options until
      // the next concrete Host block starts.
      active = false;
      aliases = [];
      continue;
    }

    if (!active || aliases.length === 0)
      continue;

    if (keyword !== 'hostname' && keyword !== 'user' && keyword !== 'port')
      continue;

    const value = tokens.slice(1).join(' ').trim();
    if (value === '')
      continue;

    for (const alias of aliases) {
      const entry = ensureEntry(alias);
      if (keyword === 'hostname') {
        entry.hostName = value;
      } else if (keyword === 'user') {
        entry.user = value;
      } else {
        const port = parsePort(value);
        if (port !== null)
          entry.port = port;
      }
    }
  }

  return [...entries.values()];
}

export default parseSshConfig;
