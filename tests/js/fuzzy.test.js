import { test, run, assert, assertEqual, assertDeepEqual, assertFalse, assertTrue } from './harness.js';
import { fold } from '../../lib/text.js';
import { matchPositions } from '../../lib/fuzzy.js';

test('exact match reports every position, one run and full span', () => {
  const match = matchPositions('spot', 'spot');
  assertTrue(match.matched);
  assertDeepEqual(match.positions, [0, 1, 2, 3]);
  assertEqual(match.runs, 1);
  assertEqual(match.span, 4);
});

test('prefix match works', () => {
  const match = matchPositions('spo', 'Spotify');
  assertTrue(match.matched);
  assertDeepEqual(match.positions, [0, 1, 2]);
  assertEqual(match.runs, 1);
  assertEqual(match.span, 3);
});

test('matching is case-insensitive', () => {
  const match = matchPositions('SPOT', 'spotify');
  assertTrue(match.matched);
  assertDeepEqual(match.positions, [0, 1, 2, 3]);
});

test('matching folds Polish diacritics but positions use the original string', () => {
  const match = matchPositions('lodz', 'Łódź');
  assertTrue(match.matched);
  assertDeepEqual(match.positions, [0, 1, 2, 3]);
  assertEqual(match.positions.length, fold('lodz').length);
});

test('diacritics in the query match a plain target', () => {
  const match = matchPositions('ŁÓDŹ', 'lodz');
  assertTrue(match.matched);
  assertDeepEqual(match.positions, [0, 1, 2, 3]);
});

test('internal word positions stay relative to the original target', () => {
  const match = matchPositions('odz', 'Łódź');
  assertTrue(match.matched);
  assertDeepEqual(match.positions, [1, 2, 3]);
});

test('scattered subsequence "spt" matches Spotify', () => {
  const match = matchPositions('spt', 'Spotify');
  assertTrue(match.matched);
  assertDeepEqual(match.positions, [0, 1, 3]);
  assertEqual(match.runs, 2);
  assertEqual(match.span, 4);
});

test('scattered match across two words counts separate runs', () => {
  const match = matchPositions('ms', 'My Spotify');
  assertTrue(match.matched);
  assertDeepEqual(match.positions, [0, 3]);
  assertEqual(match.runs, 2);
  assertEqual(match.span, 4);
});

test('word-start match inside a target', () => {
  const match = matchPositions('spo', 'My Spotify');
  assertTrue(match.matched);
  assertDeepEqual(match.positions, [3, 4, 5]);
  assertEqual(match.runs, 1);
});

test('non-subsequence does not match', () => {
  assertFalse(matchPositions('ps', 'Spotify').matched);
  assertFalse(matchPositions('xyz', 'Spotify').matched);
});

test('empty query does not match (launcher shows the empty state)', () => {
  const match = matchPositions('', 'Spotify');
  assertFalse(match.matched);
  assertDeepEqual(match.positions, []);
  assertEqual(match.runs, 0);
  assertEqual(match.span, 0);
});

test('query longer than target does not match', () => {
  assertFalse(matchPositions('abcdef', 'abc').matched);
});

test('empty or null target does not match', () => {
  assertFalse(matchPositions('a', '').matched);
  assertFalse(matchPositions('a', null).matched);
  assertFalse(matchPositions('a', undefined).matched);
});

test('repeated query characters are matched greedily in order', () => {
  const match = matchPositions('aa', 'Aplikacja');
  assertTrue(match.matched);
  assertDeepEqual(match.positions, [0, 5]);
  assertEqual(match.runs, 2);
});

test('positions length equals folded query length and indices are in range', () => {
  const target = 'Spotlight — specyfikacja MVP';
  const query = 'sptMVP';
  const match = matchPositions(query, target);
  assertTrue(match.matched);
  assertEqual(match.positions.length, fold(query).length);

  let previous = -1;
  for (const position of match.positions) {
    assert(Number.isInteger(position), `position ${position} is not an integer`);
    assert(position >= 0 && position < target.length, `position ${position} out of range`);
    assert(position >= previous, 'positions must be non-decreasing');
    previous = position;
  }
});

test('one-to-many folding still returns original-code-point positions', () => {
  const match = matchPositions('ss', 'ß');
  assertTrue(match.matched);
  assertEqual(match.positions.length, 2);
  assertDeepEqual(match.positions, [0, 0]);
  assertEqual(match.runs, 1);
});

test('positions are valid for the original Unicode target', () => {
  const target = 'Zażółć gęślą jaźń';
  const match = matchPositions('zazolc', target);
  assertTrue(match.matched);
  assertDeepEqual(match.positions, [0, 1, 2, 3, 4, 5]);
  assertEqual(match.positions.length, fold('zazolc').length);
});

run('fuzzy.test.js');