import {
  test, run, assert, assertEqual, assertDeepEqual, assertGreater, assertLess,
} from './harness.js';
import { scoreResult, rankResults } from '../../lib/ranking.js';
import { UsageStore } from '../../lib/usage.js';

test('exact equality beats a whole prefix', () => {
  const exact = scoreResult('spo', { title: 'spo' });
  const prefix = scoreResult('spo', { title: 'Spotify' });
  assertGreater(exact, prefix, 'exact should outrank prefix');
});

test('whole prefix beats a word start', () => {
  const prefix = scoreResult('spo', { title: 'Spotify' });
  const wordStart = scoreResult('spo', { title: 'My Spotify' });
  assertGreater(prefix, wordStart, 'prefix should outrank word start');
});

test('word start beats a continuous fragment in the middle', () => {
  const wordStart = scoreResult('spo', { title: 'My Spotify' });
  const middle = scoreResult('spo', { title: 'Despot' });
  assertGreater(wordStart, middle, 'word start should outrank middle fragment');
});

test('continuous fragment beats a scattered subsequence', () => {
  const continuous = scoreResult('abc', { title: 'xabcx' });
  const scattered = scoreResult('abc', { title: 'xa-b-c' });
  assertGreater(continuous, scattered, 'continuous should outrank scattered');
});

test('scattered subsequence still scores above zero', () => {
  assertGreater(scoreResult('spt', { title: 'Despotify' }), 0);
});

test('non-matching result scores zero', () => {
  assertEqual(scoreResult('zzz', { title: 'Spotify' }), 0);
});

test('empty query scores zero', () => {
  assertEqual(scoreResult('', { title: 'Spotify' }), 0);
});

test('matching the key carries no penalty relative to the title', () => {
  const byTitle = scoreResult('spo', { title: 'Spotify' });
  const byKey = scoreResult('spo', { title: 'Untitled', key: 'Spotify' });
  assertEqual(byKey, byTitle);
});

test('usage count boosts the score', () => {
  const plain = scoreResult('spo', { title: 'Spotify' }, { count: 0, lastUsed: 0 });
  const used = scoreResult('spo', { title: 'Spotify' }, { count: 5, lastUsed: 0 });
  assertEqual(used - plain, 10);
});

test('usage boost is capped at 50 uses', () => {
  const fifty = scoreResult('spo', { title: 'Spotify' }, { count: 50, lastUsed: 0 });
  const hundred = scoreResult('spo', { title: 'Spotify' }, { count: 100, lastUsed: 0 });
  assertEqual(hundred, fifty);
});

test('freshness adds +40 under one hour', () => {
  const now = 1_700_000_000_000;
  const plain = scoreResult('spo', { title: 'Spotify' }, { count: 0, lastUsed: 0 }, now);
  const fresh = scoreResult('spo', { title: 'Spotify' }, { count: 0, lastUsed: now - 1000 }, now);
  assertEqual(fresh - plain, 40);
});

test('freshness adds +20 under one day and +10 under one week', () => {
  const now = 1_700_000_000_000;
  const plain = scoreResult('spo', { title: 'Spotify' }, { count: 0, lastUsed: 0 }, now);
  const day = scoreResult('spo', { title: 'Spotify' }, { count: 0, lastUsed: now - 2 * 3600 * 1000 }, now);
  const week = scoreResult('spo', { title: 'Spotify' }, { count: 0, lastUsed: now - 2 * 24 * 3600 * 1000 }, now);
  assertEqual(day - plain, 20);
  assertEqual(week - plain, 10);
});

test('rankResults orders by descending score', () => {
  const input = [
    { id: 'middle', providerId: 'apps', title: 'Despot' },
    { id: 'prefix', providerId: 'apps', title: 'Spotify' },
    { id: 'exact', providerId: 'apps', title: 'spo' },
  ];
  const ranked = rankResults('spo', input, {});
  assertDeepEqual(ranked.map(result => result.id), ['exact', 'prefix', 'middle']);
});

test('rankResults does not mutate or reorder the input array', () => {
  const first = { id: 'a', providerId: 'apps', title: 'Despot' };
  const second = { id: 'b', providerId: 'apps', title: 'Spotify' };
  const input = [first, second];
  const before = input.slice();

  const ranked = rankResults('spo', input, {});

  assert(ranked !== input, 'rankResults must return a new array');
  assertDeepEqual(input, before, 'input array order must be unchanged');
  assert(input[0] === first && input[1] === second, 'input object references must be unchanged');
});

test('frecency changes the order: count 5 wins over count 0', () => {
  const unused = { id: 'unused', providerId: 'apps', title: 'Spotify' };
  const used = { id: 'used', providerId: 'apps', title: 'Spotify' };
  const ranked = rankResults('spo', [unused, used], {
    'apps:used': { count: 5, lastUsed: 0 },
  });
  assertEqual(ranked[0].id, 'used');
});

test('with count 0 the alphabetically first title wins the tie', () => {
  const beta = { id: 'b', providerId: 'apps', title: 'Spotify Beta' };
  const alfa = { id: 'a', providerId: 'apps', title: 'Spotify Alfa' };
  const ranked = rankResults('spotify', [beta, alfa], {
    'apps:a': { count: 0, lastUsed: 0 },
    'apps:b': { count: 0, lastUsed: 0 },
  });
  assertDeepEqual(ranked.map(result => result.id), ['a', 'b']);
});

test('equal usage falls back to title ordering', () => {
  const beta = { id: 'b', providerId: 'apps', title: 'Spotify Beta' };
  const alfa = { id: 'a', providerId: 'apps', title: 'Spotify Alfa' };
  const ranked = rankResults('spotify', [beta, alfa], {
    'apps:a': { count: 5, lastUsed: 0 },
    'apps:b': { count: 5, lastUsed: 0 },
  });
  assertDeepEqual(ranked.map(result => result.id), ['a', 'b']);
});

test('usage breaks the score tie before title ordering', () => {
  const alfa = { id: 'a', providerId: 'apps', title: 'Spotify Alfa' };
  const zulu = { id: 'z', providerId: 'apps', title: 'Spotify Zulu' };
  const ranked = rankResults('spotify', [alfa, zulu], {
    'apps:a': { count: 4, lastUsed: 0 },
    'apps:z': { count: 5, lastUsed: 0 },
  });
  assertEqual(ranked[0].id, 'z');
});

test('rankResults accepts a UsageStore instance', () => {
  const alfa = { id: 'a', providerId: 'apps', title: 'Spotify Alfa' };
  const beta = { id: 'b', providerId: 'apps', title: 'Spotify Beta' };
  const store = UsageStore.parse('{"apps:b":{"count":5,"lastUsed":0}}');
  const ranked = rankResults('spotify', [alfa, beta], store);
  assertEqual(ranked[0].id, 'b');
});

test('rankResults uses Polish collation for the title tie-breaker', () => {
  const lodz = { id: 'l', providerId: 'apps', title: 'Spotify Łódź' };
  const zebra = { id: 'z', providerId: 'apps', title: 'Spotify Zebra' };
  const ranked = rankResults('spotify', [zebra, lodz], {});
  assertEqual(ranked[0].id, 'l');
});

test('non-matching results sort after matching ones', () => {
  const matching = { id: 'match', providerId: 'apps', title: 'Spotify' };
  const other = { id: 'other', providerId: 'apps', title: 'Zebra' };
  const ranked = rankResults('spo', [other, matching], {});
  assertEqual(ranked[0].id, 'match');
});

test('rankResults handles an empty input array', () => {
  assertDeepEqual(rankResults('spo', [], {}), []);
});

test('higher score always wins, even with less usage', () => {
  const prefix = { id: 'prefix', providerId: 'apps', title: 'Spotify' };
  const middle = { id: 'middle', providerId: 'apps', title: 'Despot' };
  const ranked = rankResults('spo', [middle, prefix], {
    'apps:middle': { count: 50, lastUsed: 0 },
  });
  assert(ranked[0] === prefix, 'prefix score should beat a fully used middle match');
  assertLess(scoreResult('spo', middle, { count: 50, lastUsed: 0 }), scoreResult('spo', prefix));
});

run('ranking.test.js');