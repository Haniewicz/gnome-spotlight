// Minimal zero-dependency test harness for gjs -m.
import system from 'system';

let passed = 0;
let failed = 0;
const failures = [];
let suiteName = 'tests';

export function describe(name, fn) {
  suiteName = name;
  fn();
}

export function test(name, fn) {
  try {
    fn();
    passed++;
  } catch (error) {
    failed++;
    failures.push({ name, error });
    printerr(`  FAIL ${name}: ${error.message}`);
  }
}

// Alias matching common describe/it style.
export const it = test;

export function assert(condition, message = 'assertion failed') {
  if (!condition)
    throw new Error(message);
}

export function assertTrue(value, message = `expected truthy, got ${format(value)}`) {
  assert(Boolean(value), message);
}

export function assertFalse(value, message = `expected falsy, got ${format(value)}`) {
  assert(!value, message);
}

export function assertEqual(actual, expected, message = '') {
  if (!Object.is(actual, expected)) {
    throw new Error(
      `${message || 'values differ'}: expected ${format(expected)}, got ${format(actual)}`
    );
  }
}

export function assertNotEqual(actual, expected, message = '') {
  if (Object.is(actual, expected)) {
    throw new Error(
      `${message || 'values should differ'}: both are ${format(actual)}`
    );
  }
}

export function assertGreater(actual, expected, message = '') {
  if (!(actual > expected)) {
    throw new Error(
      `${message || 'expected greater'}: ${format(actual)} is not > ${format(expected)}`
    );
  }
}

export function assertLess(actual, expected, message = '') {
  if (!(actual < expected)) {
    throw new Error(
      `${message || 'expected less'}: ${format(actual)} is not < ${format(expected)}`
    );
  }
}

export function assertDeepEqual(actual, expected, message = '') {
  if (!deepEqual(actual, expected)) {
    throw new Error(
      `${message || 'structures differ'}: expected ${format(expected)}, got ${format(actual)}`
    );
  }
}

function deepEqual(a, b) {
  if (Object.is(a, b))
    return true;

  if (typeof a !== typeof b || a === null || b === null)
    return false;

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length)
      return false;
    return a.every((value, index) => deepEqual(value, b[index]));
  }

  if (typeof a === 'object') {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length)
      return false;
    return aKeys.every(key =>
      Object.prototype.hasOwnProperty.call(b, key) && deepEqual(a[key], b[key])
    );
  }

  return false;
}

function format(value) {
  if (typeof value === 'string')
    return JSON.stringify(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Print the per-file summary. Exits non-zero when anything failed.
 *
 * @param {string} name file name shown by tests/run_all.py
 */
export function run(name = suiteName) {
  print(`${name}: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    for (const failure of failures)
      printerr(`${failure.name}\n${failure.error.stack ?? failure.error}`);
    system.exit(1);
  }
}