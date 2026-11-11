// PURE module: no GI or shell-resource imports.
//
// The expression parser is a hand-written recursive-descent parser. Nothing
// in this module ever executes user input as code.

import { fold } from './text.js';
import { formatNumber } from './format.js';

/* --------------------------------------------------------------------------
 * Tokenizer / recursive-descent parser
 * ------------------------------------------------------------------------ */

const GROUPED_DIGITS = /(\d)[\s\u00a0\u202f]+(?=\d{3}(?:\D|$))/g;

function collapseDigitGroups(text) {
  let value = text;
  // Repeating the replacement handles "1 234 567" (one group per pass).
  for (let i = 0; i < 32; i++) {
    const next = value.replace(GROUPED_DIGITS, '$1');
    if (next === value)
      break;
    value = next;
  }
  return value;
}

function isDigit(ch) {
  return ch >= '0' && ch <= '9';
}

function tokenize(input) {
  const text = collapseDigitGroups(String(input ?? ''));
  const tokens = [];
  let i = 0;

  while (i < text.length) {
    const ch = text[i];

    if (/\s/.test(ch)) {
      i++;
      continue;
    }

    if (isDigit(ch) || (ch === '.' && isDigit(text[i + 1]))) {
      const start = i;
      while (isDigit(text[i]))
        i++;

      if (text[i] === ',' || text[i] === '.') {
        i++;
        if (!isDigit(text[i]))
          throw new Error('invalid decimal separator');
        while (isDigit(text[i]))
          i++;
      }

      if (text[i] === 'e' || text[i] === 'E') {
        let exponent = i + 1;
        if (text[exponent] === '+' || text[exponent] === '-')
          exponent++;
        if (isDigit(text[exponent])) {
          exponent++;
          while (isDigit(text[exponent]))
            exponent++;
          i = exponent;
        }
      }

      const raw = text.slice(start, i).replace(',', '.');
      const value = Number(raw);
      if (!Number.isFinite(value))
        throw new Error('invalid number');

      tokens.push({ type: 'number', value });
      continue;
    }

    if ('+-*/^()%'.includes(ch)) {
      tokens.push({ type: 'operator', value: ch });
      i++;
      continue;
    }

    if (/[A-Za-z]/.test(ch)) {
      let word = '';
      while (i < text.length && /[A-Za-z]/.test(text[i])) {
        word += text[i];
        i++;
      }
      if (word.toLowerCase() === 'of') {
        tokens.push({ type: 'operator', value: 'of' });
        continue;
      }
      throw new Error(`unexpected token: ${word}`);
    }

    throw new Error(`unexpected character: ${ch}`);
  }

  tokens.push({ type: 'eof' });
  return tokens;
}

function parseTokens(tokens) {
  let position = 0;

  function peek() {
    return tokens[position];
  }

  function isOperator(value) {
    const token = peek();
    return token?.type === 'operator' && token.value === value;
  }

  function expectOperator(value) {
    if (!isOperator(value))
      throw new Error(`expected ${value}`);
    position++;
  }

  function parsePrimary() {
    const token = peek();

    if (token?.type === 'number') {
      position++;
      return { type: 'number', value: token.value };
    }

    if (isOperator('(')) {
      position++;
      const node = parseAdditive();
      expectOperator(')');
      return node;
    }

    throw new Error('expected a number or parenthesis');
  }

  function parsePostfix() {
    let node = parsePrimary();
    while (isOperator('%')) {
      position++;
      node = { type: 'percent', expr: node };
    }
    return node;
  }

  function parsePower() {
    const base = parsePostfix();
    if (!isOperator('^'))
      return base;

    position++;
    // Right associative; the exponent may itself be unary, so 2^-3 works.
    return {
      type: 'binary',
      op: '^',
      left: base,
      right: parseUnary(),
    };
  }

  function parseUnary() {
    if (isOperator('+') || isOperator('-')) {
      const op = peek().value;
      position++;
      return { type: 'unary', op, expr: parseUnary() };
    }
    return parsePower();
  }

  function parseMultiplicative() {
    let node = parseUnary();

    while (
      isOperator('*') || isOperator('/') || isOperator('of')
    ) {
      const op = peek().value;
      position++;
      node = {
        type: 'binary',
        op,
        left: node,
        right: parseUnary(),
      };
    }

    return node;
  }

  function parseAdditive() {
    let node = parseMultiplicative();

    while (isOperator('+') || isOperator('-')) {
      const op = peek().value;
      position++;
      node = {
        type: 'binary',
        op,
        left: node,
        right: parseMultiplicative(),
      };
    }

    return node;
  }

  const ast = parseAdditive();
  if (peek()?.type !== 'eof')
    throw new Error('unexpected trailing input');
  return ast;
}

/**
 * Parse an arithmetic expression into an AST.
 *
 * @param {*} input
 * @returns {object|null} AST or null for any syntax error
 */
export function parseExpression(input) {
  if (typeof input !== 'string' || input.trim() === '')
    return null;

  try {
    return parseTokens(tokenize(input));
  } catch {
    return null;
  }
}

function evaluateNode(node) {
  if (!node || typeof node !== 'object')
    return null;

  if (node.type === 'number')
    return Number.isFinite(node.value) ? node.value : null;

  if (node.type === 'unary') {
    const value = evaluateNode(node.expr);
    if (value === null)
      return null;
    return node.op === '-' ? -value : value;
  }

  if (node.type === 'percent') {
    const value = evaluateNode(node.expr);
    return value === null ? null : value / 100;
  }

  if (node.type !== 'binary')
    return null;

  const left = evaluateNode(node.left);
  if (left === null)
    return null;

  // In an additive context a trailing percentage is relative to the left
  // operand: "250 + 10%" is 275, not 250.1.
  if (
    (node.op === '+' || node.op === '-') &&
    node.right?.type === 'percent'
  ) {
    const percent = evaluateNode(node.right.expr);
    if (percent === null)
      return null;
    const right = left * percent / 100;
    const result = node.op === '+' ? left + right : left - right;
    return Number.isFinite(result) ? result : null;
  }

  const right = evaluateNode(node.right);
  if (right === null)
    return null;

  let result;
  switch (node.op) {
  case '+':
    result = left + right;
    break;
  case '-':
    result = left - right;
    break;
  case '*':
  case 'of':
    result = left * right;
    break;
  case '/':
    if (right === 0)
      return null;
    result = left / right;
    break;
  case '^':
    result = Math.pow(left, right);
    break;
  default:
    return null;
  }

  return Number.isFinite(result) ? result : null;
}

/**
 * Evaluate a parsed expression. Syntax/AST errors and division by zero
 * return null instead of throwing or producing Infinity/NaN.
 *
 * @param {object|null} ast
 * @returns {number|null}
 */
export function evaluate(ast) {
  try {
    const value = evaluateNode(ast);
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

/* --------------------------------------------------------------------------
 * Units
 * ------------------------------------------------------------------------ */

const UNIT_TABLE = new Map();
const TEMPERATURE_UNITS = new Map();

function addUnit(category, canonical, factor, aliases = []) {
  for (const alias of [canonical, ...aliases]) {
    UNIT_TABLE.set(alias, {
      category,
      canonical,
      factor,
    });
  }
}

function addTemperature(canonical, aliases = []) {
  for (const alias of [canonical, ...aliases]) {
    TEMPERATURE_UNITS.set(alias, { category: 'temperature', canonical });
  }
}

addUnit('length', 'mm', 0.001, ['millimeter', 'millimeters', 'milimetr', 'milimetry']);
addUnit('length', 'cm', 0.01, ['centimeter', 'centimeters', 'centymetr', 'centymetry']);
addUnit('length', 'm', 1, ['meter', 'meters', 'metr', 'metry']);
addUnit('length', 'km', 1000, ['kilometer', 'kilometers', 'kilometr', 'kilometry']);
addUnit('length', 'in', 0.0254, ['inch', 'inches']);
addUnit('length', 'ft', 0.3048, ['foot', 'feet']);
addUnit('length', 'mi', 1609.344, ['mile', 'miles']);

addUnit('mass', 'mg', 0.000001, ['milligram', 'milligrams', 'miligram', 'miligramy']);
addUnit('mass', 'g', 0.001, ['gram', 'grams', 'gramy']);
addUnit('mass', 'kg', 1, ['kilogram', 'kilograms', 'kilogramy']);
addUnit('mass', 't', 1000, ['ton', 'tonne', 'tons', 'tony']);
addUnit('mass', 'oz', 0.028349523125, ['ounce', 'ounces']);
addUnit('mass', 'lb', 0.45359237, ['pound', 'pounds']);

addUnit('volume', 'ml', 0.001, ['milliliter', 'milliliters', 'mililitr', 'mililitry']);
addUnit('volume', 'l', 1, ['liter', 'liters', 'litre', 'litres']);
addUnit('volume', 'gal', 3.785411784, ['gallon', 'gallons']);
addUnit('volume', 'floz', 0.0295735295625, ['fl oz', 'fluidounce', 'fluidounces']);

addUnit('time', 's', 1, ['sec', 'secs', 'second', 'seconds', 'sekunda', 'sekundy']);
addUnit('time', 'min', 60, ['minute', 'minutes', 'minuta', 'minuty']);
addUnit('time', 'h', 3600, ['hour', 'hours', 'godzina', 'godziny']);
addUnit('time', 'd', 86400, ['day', 'days', 'dzien', 'dni']);

addUnit('data', 'b', 1, ['byte', 'bytes', 'bajt', 'bajty']);
addUnit('data', 'kb', 1000, ['kilobyte', 'kilobytes']);
addUnit('data', 'mb', 1000 ** 2, ['megabyte', 'megabytes']);
addUnit('data', 'gb', 1000 ** 3, ['gigabyte', 'gigabytes']);
addUnit('data', 'tb', 1000 ** 4, ['terabyte', 'terabytes']);
addUnit('data', 'kib', 1024, ['kibibyte', 'kibibytes']);
addUnit('data', 'mib', 1024 ** 2, ['mebibyte', 'mebibytes']);
addUnit('data', 'gib', 1024 ** 3, ['gibibyte', 'gibibytes']);

addUnit('speed', 'm/s', 1, ['mps', 'meters per second']);
addUnit('speed', 'km/h', 1 / 3.6, ['kmh', 'kph', 'kilometers per hour']);
addUnit('speed', 'mph', 0.44704, ['miles per hour']);

addTemperature('c', ['°c', 'celsius']);
addTemperature('f', ['°f', 'fahrenheit']);
addTemperature('k', ['kelvin']);

function normalizeUnit(unit) {
  return String(unit ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s*\/\s*/g, '/')
    .replace(/\s+/g, ' ');
}

function resolveUnit(unit) {
  const key = normalizeUnit(unit);
  if (key === '')
    return null;
  return UNIT_TABLE.get(key) ?? TEMPERATURE_UNITS.get(key) ?? null;
}

function temperatureToCelsius(value, unit) {
  switch (unit) {
  case 'c':
    return value;
  case 'f':
    return (value - 32) * 5 / 9;
  case 'k':
    return value - 273.15;
  default:
    return null;
  }
}

function temperatureFromCelsius(value, unit) {
  switch (unit) {
  case 'c':
    return value;
  case 'f':
    return value * 9 / 5 + 32;
  case 'k':
    return value + 273.15;
  default:
    return null;
  }
}

/**
 * Convert a value between units. Unknown units or incompatible categories
 * return null.
 *
 * @param {*} value
 * @param {string} fromUnit
 * @param {string} toUnit
 * @returns {number|null}
 */
export function convert(value, fromUnit, toUnit) {
  const amount = Number(value);
  if (!Number.isFinite(amount))
    return null;

  const from = resolveUnit(fromUnit);
  const to = resolveUnit(toUnit);
  if (!from || !to || from.category !== to.category)
    return null;

  let result;
  if (from.category === 'temperature') {
    if (from.canonical === to.canonical)
      return amount;
    const celsius = temperatureToCelsius(amount, from.canonical);
    result = celsius === null ? null : temperatureFromCelsius(celsius, to.canonical);
  } else if (from.canonical === to.canonical) {
    result = amount;
  } else {
    result = amount * from.factor / to.factor;
  }

  return Number.isFinite(result) ? result : null;
}

/* --------------------------------------------------------------------------
 * Query helpers: units, currencies, time zones
 * ------------------------------------------------------------------------ */

const AMOUNT = String.raw`[+-]?(?:\d[\d\s\u00a0\u202f]*(?:[.,]\d+)?|\d*[.,]\d+)(?:[eE][+-]?\d+)?`;
const UNIT = String.raw`[A-Za-z°µ]+(?:\s*\/\s*[A-Za-z]+)?`;
const UNIT_QUERY = new RegExp(
  String.raw`^\s*(${AMOUNT})\s*(${UNIT})\s*(?:->|→|to|in)\s*(${UNIT})\s*$`,
  'i'
);

function parseAmount(text) {
  let value = String(text ?? '').trim().replace(/[\s\u00a0\u202f]/g, '');
  if (value === '')
    return null;

  if (value.includes(',') && value.includes('.')) {
    const comma = value.lastIndexOf(',');
    const dot = value.lastIndexOf('.');
    if (comma > dot)
      value = value.replace(/\./g, '').replace(',', '.');
    else
      value = value.replace(/,/g, '');
  } else if (value.includes(',')) {
    const parts = value.split(',');
    if (parts.length > 2 && parts.slice(1).every(part => part.length === 3))
      value = parts.join('');
    else
      value = value.replace(',', '.');
  }

  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function formatValue(value) {
  return formatNumber(value, 'pl-PL');
}

function unitQuery(text) {
  const match = UNIT_QUERY.exec(text);
  if (!match)
    return null;

  const amount = parseAmount(match[1]);
  if (amount === null)
    return null;

  const from = match[2].trim();
  const to = match[3].trim();
  const value = convert(amount, from, to);
  if (value === null)
    return null;

  return {
    kind: 'unit',
    value,
    display: `${formatValue(value)} ${to}`,
    note: `${formatValue(amount)} ${from} = ${formatValue(value)} ${to}`,
    from,
    to,
  };
}

const CURRENCY_CODES = new Set([
  'AED', 'ARS', 'AUD', 'BGN', 'BRL', 'CAD', 'CHF', 'CLP', 'CNY', 'COP',
  'CZK', 'DKK', 'EGP', 'EUR', 'GBP', 'HKD', 'HUF', 'IDR', 'ILS', 'INR',
  'ISK', 'JPY', 'KRW', 'MAD', 'MXN', 'MYR', 'NOK', 'NZD', 'PEN', 'PHP',
  'PKR', 'PLN', 'RON', 'RSD', 'RUB', 'SAR', 'SEK', 'SGD', 'THB', 'TRY',
  'TWD', 'UAH', 'USD', 'UYU', 'VND', 'ZAR',
]);

const CURRENCY_SYMBOLS = {
  '$': 'USD',
  '€': 'EUR',
  '£': 'GBP',
  '¥': 'JPY',
  'zł': 'PLN',
};

const CURRENCY_QUERY = new RegExp(
  String.raw`^\s*(${AMOUNT})\s*([A-Za-z]{3}|zł|[$€£¥])\s*(?:->|→|to|in)\s*([A-Za-z]{3}|zł|[$€£¥])\s*$`,
  'i'
);

function normalizeCurrency(code) {
  const raw = String(code ?? '').trim();
  const symbol = CURRENCY_SYMBOLS[raw.toLowerCase()];
  if (symbol)
    return symbol;
  return raw.toUpperCase();
}

function rateTable(rates) {
  if (!rates)
    return null;
  if (typeof rates === 'string') {
    try {
      return JSON.parse(rates);
    } catch {
      return null;
    }
  }
  if (typeof rates !== 'object')
    return null;

  if (rates.rates && typeof rates.rates === 'object')
    return rates;
  // Also accept a bare {USD: 1.08, PLN: 4.26} rate table.
  const values = Object.values(rates);
  if (values.length > 0 && values.every(value => Number.isFinite(Number(value))))
    return { base: null, rates, asOf: rates.asOf };
  return null;
}

function isCurrencyCode(code, data) {
  if (!/^[A-Z]{3}$/.test(code))
    return false;
  if (CURRENCY_CODES.has(code))
    return true;

  const base = String(data?.base ?? '').toUpperCase();
  if (base === code)
    return true;
  if (!data?.rates || typeof data.rates !== 'object')
    return false;
  return Object.keys(data.rates).some(key => key.toUpperCase() === code);
}

function currencyRate(code, data) {
  const base = String(data?.base ?? '').toUpperCase();
  if (base === code)
    return 1;

  if (!data?.rates || typeof data.rates !== 'object')
    return null;

  for (const [key, value] of Object.entries(data.rates)) {
    if (key.toUpperCase() !== code)
      continue;
    const rate = Number(value);
    return Number.isFinite(rate) && rate > 0 ? rate : null;
  }
  return null;
}

function formatAsOf(asOf) {
  const timestamp = Number(asOf);
  if (!Number.isFinite(timestamp) || timestamp <= 0)
    return '';
  try {
    if (typeof Intl === 'object' && typeof Intl.DateTimeFormat === 'function') {
      return new Intl.DateTimeFormat('pl-PL', {
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(new Date(timestamp));
    }
  } catch {
    // Fall through to the ISO date.
  }
  return new Date(timestamp).toISOString();
}

function currencyQuery(text, rates) {
  const match = CURRENCY_QUERY.exec(text);
  if (!match)
    return { matched: false, result: null };

  const from = normalizeCurrency(match[2]);
  const to = normalizeCurrency(match[3]);
  const data = rateTable(rates);

  // "1 gib to mib" also looks like two three-letter tokens; only treat the
  // query as currency when both codes are actual currencies or cached rates.
  if (!isCurrencyCode(from, data) || !isCurrencyCode(to, data))
    return { matched: false, result: null };

  const amount = parseAmount(match[1]);
  if (amount === null || !data)
    return { matched: true, result: null };

  const fromRate = currencyRate(from, data);
  const toRate = currencyRate(to, data);
  if (fromRate === null || toRate === null)
    return { matched: true, result: null };

  const value = amount / fromRate * toRate;
  if (!Number.isFinite(value))
    return { matched: true, result: null };

  const base = String(data.base ?? '').toUpperCase();
  const cross = from === to ? 1 : toRate / fromRate;
  const asOf = formatAsOf(data.asOf);
  const parts = [
    `1 ${from} = ${formatNumber(cross, 'pl-PL')} ${to}`,
    base ? `baza: ${base}` : '',
    asOf ? `kurs z ${asOf}` : 'kurs z cache',
  ].filter(Boolean);

  return {
    matched: true,
    result: {
      kind: 'currency',
      value,
      display: `≈ ${formatNumber(Math.round(value * 100) / 100, 'pl-PL')} ${to}`,
      note: parts.join(' · '),
      from,
      to,
      base,
      rate: cross,
      asOf: Number.isFinite(Number(data.asOf)) ? Number(data.asOf) : 0,
    },
  };
}

/* Time zones --------------------------------------------------------------- */

const CITY_ZONES = {
  'tokyo': 'Asia/Tokyo',
  'tokio': 'Asia/Tokyo',
  'warszawa': 'Europe/Warsaw',
  'warsaw': 'Europe/Warsaw',
  'krakow': 'Europe/Warsaw',
  'gdansk': 'Europe/Warsaw',
  'londyn': 'Europe/London',
  'london': 'Europe/London',
  'berlin': 'Europe/Berlin',
  'paryz': 'Europe/Paris',
  'paris': 'Europe/Paris',
  'madryt': 'Europe/Madrid',
  'madrid': 'Europe/Madrid',
  'rzym': 'Europe/Rome',
  'rome': 'Europe/Rome',
  'amsterdam': 'Europe/Amsterdam',
  'bruksela': 'Europe/Brussels',
  'brussels': 'Europe/Brussels',
  'wieden': 'Europe/Vienna',
  'vienna': 'Europe/Vienna',
  'praga': 'Europe/Prague',
  'prague': 'Europe/Prague',
  'ateny': 'Europe/Athens',
  'athens': 'Europe/Athens',
  'istanbul': 'Europe/Istanbul',
  'moskwa': 'Europe/Moscow',
  'moscow': 'Europe/Moscow',
  'nowy jork': 'America/New_York',
  'new york': 'America/New_York',
  'los angeles': 'America/Los_Angeles',
  'chicago': 'America/Chicago',
  'denver': 'America/Denver',
  'toronto': 'America/Toronto',
  'meksyk': 'America/Mexico_City',
  'mexico city': 'America/Mexico_City',
  'sao paulo': 'America/Sao_Paulo',
  'buenos aires': 'America/Argentina/Buenos_Aires',
  'sydney': 'Australia/Sydney',
  'melbourne': 'Australia/Melbourne',
  'perth': 'Australia/Perth',
  'auckland': 'Pacific/Auckland',
  'honolulu': 'Pacific/Honolulu',
  'singapur': 'Asia/Singapore',
  'singapore': 'Asia/Singapore',
  'hongkong': 'Asia/Hong_Kong',
  'hong kong': 'Asia/Hong_Kong',
  'pekin': 'Asia/Shanghai',
  'beijing': 'Asia/Shanghai',
  'szanghaj': 'Asia/Shanghai',
  'shanghai': 'Asia/Shanghai',
  'seul': 'Asia/Seoul',
  'seoul': 'Asia/Seoul',
  'delhi': 'Asia/Kolkata',
  'mumbaj': 'Asia/Kolkata',
  'mumbai': 'Asia/Kolkata',
  'dubaj': 'Asia/Dubai',
  'dubai': 'Asia/Dubai',
  'bangkok': 'Asia/Bangkok',
  'jakarta': 'Asia/Jakarta',
  'kair': 'Africa/Cairo',
  'cairo': 'Africa/Cairo',
  'johannesburg': 'Africa/Johannesburg',
};

// Fixed offsets for common abbreviations. Using explicit minutes avoids the
// DST ambiguity that Intl has for abbreviations such as CET.
const ZONE_ABBREVIATIONS = {
  UTC: 0,
  GMT: 0,
  WET: 0,
  WEST: 60,
  CET: 60,
  CEST: 120,
  EET: 120,
  EEST: 180,
  BST: 60,
  EST: -300,
  EDT: -240,
  CST: -360,
  CDT: -300,
  MST: -420,
  MDT: -360,
  PST: -480,
  PDT: -420,
  MSK: 180,
  IST: 330,
  HKT: 480,
  SGT: 480,
  JST: 540,
  KST: 540,
  AEST: 600,
  AEDT: 660,
  ACST: 570,
  ACDT: 630,
  AWST: 480,
  NZST: 720,
  NZDT: 780,
};

const TIME_QUERY = /^\s*(\d{1,2})[:.](\d{2})\s*(am|pm)?\s*(.*?)\s+(?:in|->|→)\s+(.+?)\s*$/i;

function intlAvailable() {
  return typeof Intl === 'object' &&
    typeof Intl.DateTimeFormat === 'function';
}

function isValidTimeZone(zone) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

function zoneParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });

  const parts = {};
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== 'literal')
      parts[part.type] = Number(part.value);
  }
  return parts;
}

function zoneOffsetMinutes(date, timeZone) {
  const parts = zoneParts(date, timeZone);
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second
  );
  return Math.round((asUtc - date.getTime()) / 60000);
}

function resolveZone(text) {
  const raw = String(text ?? '').trim();
  if (raw === '')
    return null;

  if (raw.includes('/')) {
    if (isValidTimeZone(raw))
      return { zone: raw, label: raw };
    return null;
  }

  const abbreviation = raw.toUpperCase();
  if (Object.prototype.hasOwnProperty.call(ZONE_ABBREVIATIONS, abbreviation)) {
    return {
      offsetMinutes: ZONE_ABBREVIATIONS[abbreviation],
      label: abbreviation,
    };
  }

  const city = fold(raw).replace(/\s+/g, ' ').trim();
  if (CITY_ZONES[city])
    return { zone: CITY_ZONES[city], label: raw };

  return null;
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function localDateParts(date) {
  return {
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    day: date.getDate(),
    hour: date.getHours(),
    minute: date.getMinutes(),
  };
}

function sourceDateParts(source, now) {
  if (source?.offsetMinutes !== undefined) {
    const shifted = new Date(now.getTime() + source.offsetMinutes * 60000);
    return {
      year: shifted.getUTCFullYear(),
      month: shifted.getUTCMonth() + 1,
      day: shifted.getUTCDate(),
      hour: shifted.getUTCHours(),
      minute: shifted.getUTCMinutes(),
    };
  }

  if (source?.zone) {
    const parts = zoneParts(now, source.zone);
    return {
      year: parts.year,
      month: parts.month,
      day: parts.day,
      hour: parts.hour,
      minute: parts.minute,
    };
  }

  return localDateParts(now);
}

function instantForLocal(source, parts) {
  const wallClock = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    0,
    0
  );

  if (source?.offsetMinutes !== undefined)
    return new Date(wallClock - source.offsetMinutes * 60000);

  if (source?.zone) {
    let offset = zoneOffsetMinutes(new Date(wallClock), source.zone);
    let instant = new Date(wallClock - offset * 60000);
    const corrected = zoneOffsetMinutes(instant, source.zone);
    if (corrected !== offset)
      instant = new Date(wallClock - corrected * 60000);
    return instant;
  }

  // Interpret the wall clock in the system's local zone.
  return new Date(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    0,
    0
  );
}

function formatInstant(instant, target) {
  if (target.zone) {
    return new Intl.DateTimeFormat('pl-PL', {
      timeZone: target.zone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(instant);
  }

  const shifted = new Date(instant.getTime() + target.offsetMinutes * 60000);
  return `${pad2(shifted.getUTCHours())}:${pad2(shifted.getUTCMinutes())}`;
}

function dayKey(instant, target) {
  if (target.zone) {
    const parts = zoneParts(instant, target.zone);
    return `${parts.year}-${parts.month}-${parts.day}`;
  }
  const shifted = new Date(instant.getTime() + target.offsetMinutes * 60000);
  return `${shifted.getUTCFullYear()}-${shifted.getUTCMonth() + 1}-${shifted.getUTCDate()}`;
}

function timezoneQuery(text) {
  const match = TIME_QUERY.exec(text);
  if (!match)
    return null;

  if (!intlAvailable())
    return null;

  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const meridiem = match[3]?.toLowerCase() ?? '';
  const sourceText = match[4].trim();
  const targetText = match[5].trim();

  if (!Number.isInteger(hour) || !Number.isInteger(minute) || minute > 59)
    return null;

  if (meridiem) {
    if (hour < 1 || hour > 12)
      return null;
    hour = hour % 12 + (meridiem === 'pm' ? 12 : 0);
  } else if (hour > 23) {
    return null;
  }

  const target = resolveZone(targetText);
  if (!target)
    return null;

  const source = sourceText === '' ? null : resolveZone(sourceText);
  if (sourceText !== '' && !source)
    return null;

  try {
    const parts = sourceDateParts(source, new Date());
    parts.hour = hour;
    parts.minute = minute;

    const instant = instantForLocal(source, parts);
    if (!Number.isFinite(instant.getTime()))
      return null;

    const display = formatInstant(instant, target);
    const sourceDay = dayKey(instant, source ?? { offsetMinutes: -new Date().getTimezoneOffset() });
    const targetDay = dayKey(instant, target);
    const daySuffix = sourceDay === targetDay ? '' : ' (inny dzień)';
    const sourceLabel = sourceText || 'czas lokalny';

    return {
      kind: 'timezone',
      value: instant.getTime(),
      display,
      note: `${pad2(hour)}:${pad2(minute)} ${sourceLabel} = ${display} ${targetText}${daySuffix}`,
      source: sourceText || 'local',
      target: targetText,
      targetZone: target.zone ?? `UTC${target.offsetMinutes >= 0 ? '+' : ''}${target.offsetMinutes / 60}`,
    };
  } catch {
    return null;
  }
}

/* --------------------------------------------------------------------------
 * Public query parser
 * ------------------------------------------------------------------------ */

/**
 * Recognize an expression, unit conversion, currency conversion or time-zone
 * conversion and return a renderable result object.
 *
 * @param {string} text
 * @param {object|null} [rates] {base, rates, asOf}; injected, never fetched
 * @returns {{kind: string, value: number, display: string, note: string}|null}
 */
export function parseQuery(text, rates = null) {
  if (typeof text !== 'string' || text.trim() === '')
    return null;

  const query = text.trim();

  const timezone = timezoneQuery(query);
  if (timezone)
    return timezone;

  const currency = currencyQuery(query, rates);
  if (currency.matched)
    return currency.result;

  const unit = unitQuery(query);
  if (unit)
    return unit;

  const ast = parseExpression(query);
  if (!ast)
    return null;

  const value = evaluate(ast);
  if (value === null)
    return null;

  const display = formatValue(value);
  return {
    kind: 'expression',
    value,
    display,
    note: `${query} = ${display}`,
  };
}

export default {
  parseExpression,
  evaluate,
  convert,
  parseQuery,
};