import {
  test, run, assert, assertEqual, assertTrue, assertFalse,
} from './harness.js';
import {
  parseExpression, evaluate, convert, parseQuery,
} from '../../lib/calculator.js';

const RATES = {
  base: 'EUR',
  rates: { USD: 1.08, PLN: 4.26 },
  asOf: 1_700_000_000_000,
};

function assertClose(actual, expected, epsilon = 1e-9) {
  assert(
    typeof actual === 'number' && Math.abs(actual - expected) <= epsilon,
    `expected ${expected}, got ${actual}`
  );
}

function expressionValue(input) {
  const ast = parseExpression(input);
  assertTrue(ast, `parseExpression(${JSON.stringify(input)}) returned null`);
  return evaluate(ast);
}

test('2+2 = 4', () => {
  assertEqual(expressionValue('2+2'), 4);
});

test('2+2*2 = 6 (operator precedence)', () => {
  assertEqual(expressionValue('2+2*2'), 6);
});

test('(2+2)*2 = 8 (parentheses)', () => {
  assertEqual(expressionValue('(2+2)*2'), 8);
});

test('2^10 = 1024 (right associative power)', () => {
  assertEqual(expressionValue('2^10'), 1024);
  assertEqual(expressionValue('2^3^2'), 512);
});

test('-3*2 = -6 (unary minus)', () => {
  assertEqual(expressionValue('-3*2'), -6);
});

test('comma is accepted as a decimal separator', () => {
  assertEqual(expressionValue('12,5'), 12.5);
});

test('grouped thousands and comma decimals: 1 234,56 + 1', () => {
  assertClose(expressionValue('1 234,56 + 1'), 1235.56);
});

test('scientific notation 1.5e3', () => {
  assertEqual(expressionValue('1.5e3'), 1500);
});

test('250 + 10% = 275 (relative percentage)', () => {
  assertEqual(expressionValue('250 + 10%'), 275);
});

test('10% of 250 = 25', () => {
  assertEqual(expressionValue('10% of 250'), 25);
});

test('division by zero returns null, never Infinity', () => {
  assertEqual(evaluate(parseExpression('1/0')), null);
  assertEqual(parseQuery('1/0'), null);
});

test('invalid syntax returns null instead of throwing', () => {
  assertEqual(parseExpression('2+'), null);
  assertEqual(parseExpression('(2+2'), null);
  assertEqual(parseExpression(''), null);
  assertEqual(parseExpression('2 2'), null);
  assertEqual(parseQuery('2+'), null);
});

test('5 km to m = 5000', () => {
  const parsed = parseQuery('5 km to m');
  assertTrue(parsed);
  assertEqual(parsed.kind, 'unit');
  assertEqual(parsed.value, 5000);
});

test('100 c to f = 212 (temperature offset)', () => {
  const parsed = parseQuery('100 c to f');
  assertTrue(parsed);
  assertEqual(parsed.kind, 'unit');
  assertClose(parsed.value, 212);
  assertClose(convert(32, 'f', 'c'), 0);
});

test('1 gb to mb = 1000 (decimal data units)', () => {
  assertEqual(convert(1, 'gb', 'mb'), 1000);
});

test('1 gib to mb = 1073.741824 (binary data units)', () => {
  const parsed = parseQuery('1 gib to mb');
  assertTrue(parsed);
  assertEqual(parsed.kind, 'unit');
  assertClose(parsed.value, 1073.741824);
});

test('negative temperature in kelvin', () => {
  assertClose(convert(-40, 'c', 'k'), 233.15);
  const parsed = parseQuery('-40 c to k');
  assertTrue(parsed);
  assertClose(parsed.value, 233.15);
});

test('unknown units and incompatible categories return null', () => {
  assertEqual(convert(1, 'furlong', 'm'), null);
  assertEqual(convert(1, 'kg', 'km'), null);
  assertEqual(parseQuery('3 furlong to m'), null);
});

test('128 usd in pln uses the injected rates', () => {
  const parsed = parseQuery('128 usd in pln', RATES);
  assertTrue(parsed);
  assertEqual(parsed.kind, 'currency');
  assertClose(parsed.value, 128 / 1.08 * 4.26, 1e-9);
  assertTrue(String(parsed.display).includes('PLN'));
  assertTrue(String(parsed.note).includes('EUR'));
});

test('currency without a rate returns null', () => {
  assertEqual(parseQuery('128 usd in pln', {
    base: 'EUR',
    rates: { USD: 1.08 },
  }), null);
  assertEqual(parseQuery('128 usd in pln'), null);
});

test('18:00 CET in Tokyo is rendered through ICU', () => {
  const parsed = parseQuery('18:00 CET in Tokyo');
  // gjs 1.90 on the target system ships ICU; if it ever does not,
  // parseQuery returns null by contract instead of inventing a time.
  assertTrue(parsed, 'Intl/ICU is unavailable in this runtime');
  assertEqual(parsed.kind, 'timezone');
  assertEqual(parsed.display, '02:00');
  assertTrue(String(parsed.note).includes('Tokyo'));
});

test('parseQuery recognizes expressions with units attached', () => {
  const parsed = parseQuery('12,5');
  assertTrue(parsed);
  assertEqual(parsed.kind, 'expression');
  assertEqual(parsed.value, 12.5);
  assertFalse(parsed.kind === 'unit');
});

run('calculator.test.js');