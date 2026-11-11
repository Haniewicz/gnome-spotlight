import system from 'system';

import {
  assert, assertDeepEqual, assertEqual, assertFalse, assertLess, assertTrue,
} from './harness.js';
import { ProviderPriority, ProviderRegistry } from '../../lib/providers/registry.js';

const cases = [];
let passed = 0;
let failed = 0;

function test(name, fn) {
  cases.push({ name, fn });
}

function makeProvider(id, priority, results, options = {}) {
  return {
    id,
    title: id,
    priority,
    prefix: null,
    timeoutMs: 100,
    search: () => results,
    ...options,
  };
}

function makeResult(providerId, id, title, options = {}) {
  return {
    id,
    providerId,
    title,
    ...options,
  };
}

test('providers are ordered by ascending priority', async () => {
  const registry = new ProviderRegistry();
  registry.register(makeProvider('low', ProviderPriority.LOW, [
    makeResult('low', 'l', 'Spotify'),
  ]));
  registry.register(makeProvider('high', ProviderPriority.HIGH, [
    makeResult('high', 'h', 'Spotify'),
  ]));
  registry.register(makeProvider('normal', ProviderPriority.NORMAL, [
    makeResult('normal', 'n', 'Spotify'),
  ]));

  const { results, errors } = await registry.search('spotify');

  assertDeepEqual(results.map(result => result.providerId), ['high', 'normal', 'low']);
  assertEqual(errors.length, 0);
});

test('dedupe uses providerId + id and keeps the first occurrence', async () => {
  const registry = new ProviderRegistry();
  registry.register(makeProvider('first', ProviderPriority.HIGH, [
    makeResult('apps', 'same', 'Pierwszy'),
  ]));
  registry.register(makeProvider('second', ProviderPriority.LOW, [
    makeResult('apps', 'same', 'Drugi'),
  ]));

  const { results } = await registry.search('same');

  assertEqual(results.length, 1);
  assertEqual(results[0].title, 'Pierwszy');
});

test('timeout is reported and does not block the remaining results', async () => {
  const registry = new ProviderRegistry();
  const slow = makeProvider('slow', ProviderPriority.HIGH, [], {
    timeoutMs: 20,
    search: () => new Promise(resolve => {
      setTimeout(() => resolve([makeResult('slow', 's', 'slow')]), 200);
    }),
  });
  registry.register(slow);
  registry.register(makeProvider('fast', ProviderPriority.LOW, [
    makeResult('fast', 'f', 'fast'),
  ], { timeoutMs: 200 }));

  const started = Date.now();
  const { results, errors } = await registry.search('slow');
  const elapsed = Date.now() - started;

  assertLess(elapsed, 120, `search took ${elapsed} ms, expected < 120 ms`);
  assertFalse(results.some(result => result.providerId === 'slow'));
  assertTrue(results.some(result => result.providerId === 'fast'));

  const timeoutError = errors.find(error => error.providerId === 'slow');
  assertTrue(timeoutError, 'missing timeout error entry');
  assertEqual(timeoutError.reason, 'timeout');
});

test('a synchronously throwing provider reports reason "error"', async () => {
  const registry = new ProviderRegistry();
  registry.register(makeProvider('boom', ProviderPriority.HIGH, [], {
    search: () => {
      throw new Error('boom');
    },
  }));
  registry.register(makeProvider('ok', ProviderPriority.LOW, [
    makeResult('ok', '1', 'OK'),
  ]));

  const { results, errors } = await registry.search('ok');

  assertTrue(results.some(result => result.providerId === 'ok'));
  const error = errors.find(entry => entry.providerId === 'boom');
  assertTrue(error, 'missing error entry');
  assertEqual(error.reason, 'error');
});

test('a rejected provider promise also reports reason "error"', async () => {
  const registry = new ProviderRegistry();
  registry.register(makeProvider('rejected', ProviderPriority.HIGH, [], {
    search: () => Promise.reject(new Error('nope')),
  }));
  registry.register(makeProvider('ok', ProviderPriority.LOW, [
    makeResult('ok', '1', 'OK'),
  ]));

  const { results, errors } = await registry.search('ok');

  assertEqual(results.length, 1);
  assertEqual(errors[0].providerId, 'rejected');
  assertEqual(errors[0].reason, 'error');
});

test('a consumed prefix strips the prefix and suppresses plain providers', async () => {
  const registry = new ProviderRegistry();
  let plainCalled = false;
  let acceptedQuery = null;

  registry.register(makeProvider('plain', ProviderPriority.NORMAL, [], {
    search: () => {
      plainCalled = true;
      return [makeResult('plain', 'p', 'ls')];
    },
  }));
  registry.register(makeProvider('commands', ProviderPriority.HIGH, [], {
    prefix: '>',
    search: query => {
      acceptedQuery = query;
      return [makeResult('commands', 'ls', 'ls')];
    },
  }));

  const { results, timings } = await registry.search('>ls');

  assertEqual(acceptedQuery, 'ls');
  assertFalse(plainCalled, 'plain provider must not run when a prefix was consumed');
  assertEqual(results.length, 1);
  assertEqual(results[0].providerId, 'commands');
  assertEqual(typeof timings.commands, 'number');
  assertFalse('plain' in timings, 'skipped provider must not have a timing entry');
});

test('a prefixed provider is not called when the query has no prefix', async () => {
  const registry = new ProviderRegistry();
  let commandsCalled = false;

  registry.register(makeProvider('plain', ProviderPriority.NORMAL, [
    makeResult('plain', 'p', 'ls'),
  ]));
  registry.register(makeProvider('commands', ProviderPriority.HIGH, [], {
    prefix: '>',
    search: () => {
      commandsCalled = true;
      return [makeResult('commands', 'ls', 'ls')];
    },
  }));

  const { results } = await registry.search('ls');

  assertFalse(commandsCalled, 'prefixed provider must stay idle without its prefix');
  assertEqual(results.length, 1);
  assertEqual(results[0].providerId, 'plain');
});

test('plain providers never receive a reserved-prefix query', async () => {
  const registry = new ProviderRegistry();
  let called = false;

  registry.register(makeProvider('plain', ProviderPriority.NORMAL, [], {
    search: () => {
      called = true;
      return [makeResult('plain', 'p', '>ls')];
    },
  }));

  const { results } = await registry.search('>ls');

  assertFalse(called, 'plain provider saw a consumed prefix');
  assertEqual(results.length, 0);
});

test('unregister removes a provider', async () => {
  const registry = new ProviderRegistry();
  registry.register(makeProvider('gone', ProviderPriority.HIGH, [
    makeResult('gone', '1', 'Gone'),
  ]));

  assertTrue(registry.unregister('gone'));
  assertFalse(registry.unregister('gone'));

  const { results } = await registry.search('gone');
  assertEqual(results.length, 0);
  assertEqual(registry.list().length, 0);
});

test('list returns a copy of the registry array', () => {
  const registry = new ProviderRegistry();
  const provider = makeProvider('apps', ProviderPriority.HIGH, [
    makeResult('apps', '1', 'Files'),
  ]);
  registry.register(provider);

  const copy = registry.list();
  assertEqual(copy.length, 1);
  assertTrue(copy[0] === provider, 'list should expose the registered provider');

  copy.pop();
  copy.length = 0;
  assertEqual(copy.length, 0);
  assertEqual(registry.list().length, 1);
});

test('timings cover exactly the providers that ran', async () => {
  const registry = new ProviderRegistry();
  registry.register(makeProvider('one', ProviderPriority.HIGH, [
    makeResult('one', '1', 'One'),
  ]));
  registry.register(makeProvider('two', ProviderPriority.NORMAL, [
    makeResult('two', '2', 'Two'),
  ]));

  const { timings } = await registry.search('o');

  assertEqual(Object.keys(timings).sort().join(','), 'one,two');
  assertTrue(Number.isFinite(timings.one));
  assertTrue(Number.isFinite(timings.two));
});

test('registry clears every timeout timer before resolving', async () => {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const activeTimers = new Set();
  let createdTimers = 0;

  globalThis.setTimeout = function (callback, delay, ...args) {
    const id = originalSetTimeout(() => {
      activeTimers.delete(id);
      callback();
    }, delay, ...args);
    activeTimers.add(id);
    createdTimers++;
    return id;
  };
  globalThis.clearTimeout = function (id) {
    activeTimers.delete(id);
    return originalClearTimeout(id);
  };

  try {
    const registry = new ProviderRegistry();
    registry.register(makeProvider('never', ProviderPriority.HIGH, [], {
      timeoutMs: 20,
      search: () => new Promise(() => {}),
    }));
    registry.register(makeProvider('fast', ProviderPriority.LOW, [
      makeResult('fast', '1', 'Fast'),
    ], { timeoutMs: 50 }));

    const { timings, errors } = await registry.search('fast');

    assertEqual(Object.keys(timings).sort().join(','), 'fast,never');
    assertTrue(createdTimers >= 2, 'registry should arm a timer per provider');
    assertEqual(activeTimers.size, 0, 'registry left an active timer behind');
    assertTrue(errors.some(entry => entry.providerId === 'never' &&
      entry.reason === 'timeout'));
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});

test('within one priority, higher score comes first', async () => {
  const registry = new ProviderRegistry();
  registry.register(makeProvider('prefix', ProviderPriority.NORMAL, [
    makeResult('prefix', '1', 'Spotify'),
  ]));
  registry.register(makeProvider('exact', ProviderPriority.NORMAL, [
    makeResult('exact', '1', 'Spot'),
  ]));

  const { results } = await registry.search('spot');
  assertDeepEqual(results.map(result => result.providerId), ['exact', 'prefix']);
});

test('registering the same id replaces instead of duplicating', async () => {
  const registry = new ProviderRegistry();
  registry.register(makeProvider('apps', ProviderPriority.HIGH, [
    makeResult('apps', 'old', 'Old'),
  ]));
  registry.register(makeProvider('apps', ProviderPriority.HIGH, [
    makeResult('apps', 'new', 'New'),
  ]));

  assertEqual(registry.list().length, 1);
  const { results } = await registry.search('new');
  assertEqual(results.length, 1);
  assertEqual(results[0].id, 'new');
});

for (const entry of cases) {
  try {
    await entry.fn();
    passed++;
  } catch (error) {
    failed++;
    printerr(`  FAIL ${entry.name}: ${error.message}`);
    if (error.stack)
      printerr(error.stack);
  }
}

print(`registry: ${passed} passed, ${failed} failed`);
if (failed > 0)
  system.exit(1);