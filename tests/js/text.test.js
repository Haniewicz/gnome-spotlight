import { test, run, assertEqual, assertDeepEqual } from './harness.js';
import { fold, normalize } from '../../lib/text.js';

test('fold maps Polish Łódź to lodz', () => {
  assertEqual(fold('Łódź'), 'lodz');
});

test('fold maps Polish Ćma to cma', () => {
  assertEqual(fold('Ćma'), 'cma');
});

test('fold maps the full Polish diacritic alphabet', () => {
  assertEqual(fold('Zażółć gęślą jaźń'), 'zazolc gesla jazn');
});

test('fold maps common Latin/German diacritics', () => {
  assertEqual(fold('ÄÖÜ ß ÉÈÊ Ñ Ç'), 'aou ss eee n c');
});

test('fold is case-insensitive', () => {
  assertEqual(fold('SpOtIfY'), 'spotify');
});

test('fold handles null, undefined and empty strings', () => {
  assertEqual(fold(null), '');
  assertEqual(fold(undefined), '');
  assertEqual(fold(''), '');
});

test('fold leaves ASCII and punctuation untouched', () => {
  assertEqual(fold('systemctl --user restart'), 'systemctl --user restart');
});

test('normalize folds, trims and collapses whitespace', () => {
  assertEqual(normalize('  Łódź\t Gęślą   Jaźń  '), 'lodz gesla jazn');
});

test('normalize keeps a single space between words', () => {
  assertEqual(normalize('a\n\nb'), 'a b');
});

test('fold round-trips a string already without diacritics', () => {
  assertEqual(fold('spotlight@haniewicz.dev'), 'spotlight@haniewicz.dev');
});

test('fold output is a string for numbers', () => {
  assertEqual(fold(128), '128');
});

run('text.test.js');