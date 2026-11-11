import {
  test, run, assertEqual,
} from './harness.js';
import { ttlCache } from '../../lib/cache.js';

function clock(start = 1000) {
  const state = { value: start };
  return {
    now: () => state.value,
    advance: milliseconds => {
      state.value += milliseconds;
    },
  };
}

test('a value is computed once and reused inside the TTL', () => {
  const time = clock();
  const cache = ttlCache({ ttlMs: 100, now: time.now });
  let calls = 0;
  const compute = () => `value-${++calls}`;

  assertEqual(cache.get('key', compute), 'value-1');
  assertEqual(cache.get('key', compute), 'value-1');
  assertEqual(calls, 1);
  assertEqual(cache.stats().hits, 1);
  assertEqual(cache.stats().misses, 1);
});

test('an entry expires after the TTL and is recomputed', () => {
  const time = clock();
  const cache = ttlCache({ ttlMs: 100, now: time.now });
  let calls = 0;
  const compute = () => ++calls;

  assertEqual(cache.get('key', compute), 1);
  time.advance(99);
  assertEqual(cache.get('key', compute), 1);
  time.advance(1);
  assertEqual(cache.get('key', compute), 2);
  assertEqual(calls, 2);
  assertEqual(cache.stats().expired, 1);
});

test('invalidate drops the whole cache and the next get recomputes', () => {
  const time = clock();
  const cache = ttlCache({ ttlMs: 100, now: time.now });
  let calls = 0;
  const compute = () => ++calls;

  cache.get('a', compute);
  cache.get('b', compute);
  assertEqual(cache.stats().size, 2);

  cache.invalidate();
  assertEqual(cache.stats().size, 0);
  assertEqual(cache.get('a', compute), 3);
});

test('invalidate(key) drops only the selected key', () => {
  const cache = ttlCache({ ttlMs: 100, now: () => 0 });
  cache.get('a', () => 'a');
  cache.get('b', () => 'b');

  cache.invalidate('a');
  assertEqual(cache.stats().size, 1);
  assertEqual(cache.get('b', () => 'changed'), 'b');
});

test('clear removes entries and counters without leaking stale state', () => {
  const time = clock();
  const cache = ttlCache({ ttlMs: 100, now: time.now });

  for (let index = 0; index < 20; index++)
    cache.get(`key-${index}`, value => value);

  assertEqual(cache.stats().size, 20);
  cache.clear();

  const stats = cache.stats();
  assertEqual(stats.size, 0);
  assertEqual(stats.hits, 0);
  assertEqual(stats.misses, 0);
  assertEqual(cache.has('key-0'), false);
});

test('different keys are cached independently', () => {
  const cache = ttlCache({ ttlMs: 100, now: () => 0 });
  assertEqual(cache.get('one', () => 1), 1);
  assertEqual(cache.get('two', () => 2), 2);
  assertEqual(cache.get('one', () => 3), 1);
});

run('cache.test.js');
