// PURE tests for lib/searchStream.js (run with gjs -m).
import {
  cacheKey,
  createLruCache,
  mergeSources,
  searchDaemonSources,
  stabilize,
} from '../../lib/searchStream.js';
import {
  assert,
  assertDeepEqual,
  assertEqual,
  assertFalse,
  assertTrue,
  describe,
  test,
  run,
} from './harness.js';

function result(providerId, id, title, score = 0) {
  return { providerId, id, title, score };
}

describe('searchStream', () => {
  test('mergeSources dedupes provider+id and prefers Shell windows', () => {
    const daemonWindow = result('windows', '42', 'daemon window');
    const daemonApp = result('apps', 'firefox.desktop', 'Firefox');
    const daemonSecond = result('files', '/tmp/a.txt', 'a.txt');
    const shellWindow = result('windows', '42', 'Shell window');
    const shellWindow2 = result('windows', '43', 'Second window');

    const merged = mergeSources(
      [daemonApp, daemonWindow, daemonSecond],
      [shellWindow, shellWindow2, result('apps', 'firefox.desktop', 'local')],
      { limit: 20 }
    );

    assertEqual(merged.length, 4);
    assertEqual(merged[0].title, 'Firefox');
    assertEqual(merged[1].title, 'Shell window');
    assertEqual(merged[1], shellWindow);
    assertEqual(merged[2].title, 'a.txt');
    assertEqual(merged[3].title, 'Second window');
  });

  test('mergeSources truncates to limit and handles zero/negative limits', () => {
    const daemon = [
      result('apps', '1', 'one'),
      result('apps', '2', 'two'),
      result('apps', '3', 'three'),
    ];

    assertEqual(mergeSources(daemon, [], { limit: 2 }).length, 2);
    assertDeepEqual(mergeSources(daemon, [], { limit: 2 }).map(item => item.id), ['1', '2']);
    assertEqual(mergeSources(daemon, [], { limit: 0 }).length, 0);
    assertEqual(mergeSources(daemon, [], { limit: -5 }).length, 0);
  });

  test('stabilize preserves previous reference for an identical identity set', () => {
    const one = result('apps', '1', 'one');
    const two = result('windows', '2', 'two');
    const previous = [one, two];
    const next = [
      { ...two, title: 'two updated' },
      { ...one, title: 'one updated' },
    ];

    const stable = stabilize(previous, next);
    assertEqual(stable, previous);
    assertTrue(stable === previous);
  });

  test('stabilize returns next for a changed set and for the first response', () => {
    const previous = [result('apps', '1', 'one')];
    const next = [result('apps', '2', 'two')];

    assertEqual(stabilize(previous, next), next);
    assertEqual(stabilize(null, next), next);
    assertEqual(stabilize(undefined, next), next);
    assertEqual(stabilize(previous, []).length, 0);
  });

  test('LRU keeps 20 entries and evicts the least recently used', () => {
    const cache = createLruCache(20);
    for (let i = 0; i < 20; i++)
      cache.remember(`q${i}`, i);

    assertEqual(cache.size, 20);

    // Refresh q0, then insert the 21st entry: q1 is now the oldest.
    assertEqual(cache.lookup('q0'), 0);
    cache.remember('q20', 20);

    assertEqual(cache.size, 20);
    assertEqual(cache.lookup('q1'), undefined);
    assertEqual(cache.lookup('q0'), 0);
    assertEqual(cache.lookup('q20'), 20);

    // Re-remembering an existing key must not grow the cache.
    cache.remember('q0', 'updated');
    assertEqual(cache.size, 20);
    assertEqual(cache.lookup('q0'), 'updated');
  });

  test('cacheKey is stable and separates modes', () => {
    assertEqual(cacheKey('spot', ''), cacheKey('spot', ''));
    assertNotSame(cacheKey('spot', ''), cacheKey('spot', 'files'));
    assertNotSame(cacheKey('spot', ''), cacheKey('spot', 'commands'));
    assertNotSame(cacheKey('spot', ''), cacheKey('spotx', ''));
  });
});

function assertNotSame(actual, expected) {
  assertFalse(
    Object.is(actual, expected),
    `expected different values, got ${JSON.stringify(actual)}`
  );
}

// The daemon branch of extension._onSearchChanged is the same helper call the
// modal exercises. This fake-client test proves that a successful daemon
// search only touches the daemon + Shell windows stream and never falls back
// to the enumerating in-process registry.
let daemonCalls = 0;
let windowsCalls = 0;
let fallbackCalls = 0;
let daemonResponse = null;
let fallbackResponse = null;

const daemonResult = result('apps', 'org.example.App.desktop', 'Example');
const windowResult = result('windows', '7', 'Example window');
const timeoutResult = { results: [], stats: {}, source: 'timeout' };
const fallbackResult = result('files', '/tmp/f.txt', 'f.txt');

// Top-level await is supported by the gjs ESM runtime used by the gate.
await searchDaemonSources({
  query: 'example',
  mode: 'apps',
  limit: 5,
  daemonSearch: async (query, options) => {
    daemonCalls++;
    assertEqual(query, 'example');
    assertEqual(options.mode, 'apps');
    assertEqual(options.limit, 5);
    return { results: [daemonResult], stats: { ms: { apps: 4 } }, source: 'daemon' };
  },
  localWindows: async () => {
    windowsCalls++;
    return [windowResult];
  },
  fallbackSearch: async () => {
    fallbackCalls++;
    return { results: [fallbackResult], stats: {}, source: 'offline' };
  },
}).then(response => {
  daemonResponse = response;
});

await searchDaemonSources({
  query: 'missing',
  limit: 5,
  daemonSearch: async () => timeoutResult,
  localWindows: async () => [],
  fallbackSearch: async () => {
    fallbackCalls++;
    return { results: [fallbackResult], stats: {}, source: 'offline' };
  },
}).then(response => {
  fallbackResponse = response;
});

describe('searchStream daemon frontend', () => {
  test('daemon success merges only daemon + windows and skips fallback', () => {
    assertEqual(daemonCalls, 1);
    assertEqual(windowsCalls, 1);
    assertEqual(fallbackCalls, 1); // only the timeout request below
    assertEqual(daemonResponse.source, 'daemon');
    assertDeepEqual(
      daemonResponse.results.map(item => item.providerId),
      ['apps', 'windows']
    );
    assertEqual(daemonResponse.stats.ms.apps, 4);
  });

  test('daemon timeout uses the in-process fallback and reports offline', () => {
    assertEqual(fallbackResponse.source, 'offline');
    assertEqual(fallbackResponse.results.length, 1);
    assertEqual(fallbackResponse.results[0], fallbackResult);
  });
});

run('searchStream.test.js');