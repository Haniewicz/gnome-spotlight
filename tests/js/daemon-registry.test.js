import system from 'system';

import {
  assert, assertDeepEqual, assertEqual, assertFalse, assertLess, assertTrue,
} from './harness.js';
import {
  DaemonRegistry,
  createDaemonRegistry,
  createRegistry,
} from '../../searchd/registry.js';

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

test('factory functions return a DaemonRegistry', () => {
  assertTrue(createDaemonRegistry() instanceof DaemonRegistry);
  assertTrue(createRegistry() instanceof DaemonRegistry);
});

test('providers run in parallel and results keep priority order', async () => {
  const registry = new DaemonRegistry();
  let started = 0;
  let release;
  const gate = new Promise(resolve => {
    release = resolve;
  });

  const slow = makeProvider('slow', 0, [makeResult('slow', '1', 'Spot slow')], {
    timeoutMs: 500,
    search: async () => {
      started++;
      await gate;
      return [makeResult('slow', '1', 'Spot slow')];
    },
  });
  const fast = makeProvider('fast', 10, [makeResult('fast', '1', 'Spot fast')], {
    timeoutMs: 500,
    search: () => {
      started++;
      return [makeResult('fast', '1', 'Spot fast')];
    },
  });

  registry.register(slow);
  registry.register(fast);

  const pending = registry.search('spot');
  setTimeout(release, 20);
  const response = await pending;

  assertEqual(started, 2);
  assertDeepEqual(
    response.results.map(result => result.providerId),
    ['slow', 'fast']
  );
});

test('timeout is isolated and still appears in stats.ms', async () => {
  const registry = new DaemonRegistry();
  registry.register(makeProvider('never', 0, [], {
    timeoutMs: 20,
    search: () => new Promise(() => {}),
  }));
  registry.register(makeProvider('fast', 10, [
    makeResult('fast', '1', 'Spot fast'),
  ], { timeoutMs: 100 }));

  const started = Date.now();
  const response = await registry.search('spot');
  const elapsed = Date.now() - started;

  assertLess(elapsed, 120, `search took ${elapsed} ms`);
  assertEqual(response.results.length, 1);
  assertEqual(response.errors[0].providerId, 'never');
  assertEqual(response.errors[0].reason, 'timeout');
  assertTrue(Number.isFinite(response.stats.ms.never));
  assertTrue(Number.isFinite(response.stats.ms.fast));
  assertEqual(Object.keys(response.stats.ms).sort().join(','), 'fast,never');
});

test('timed out providers contribute no results', async () => {
  const registry = new DaemonRegistry();
  registry.register(makeProvider('slow', 0, [], {
    timeoutMs: 10,
    search: () => new Promise(resolve =>
      setTimeout(() => resolve([makeResult('slow', '1', 'Spot slow')]), 80)),
  }));

  const response = await registry.search('spot');
  assertEqual(response.results.length, 0);
  assertTrue(response.stats.ms.slow >= 0);
});

test('dedupe uses providerId + id and keeps the first occurrence', async () => {
  const registry = new DaemonRegistry();
  registry.register(makeProvider('first', 0, [
    makeResult('apps', 'same', 'Pierwszy'),
  ]));
  registry.register(makeProvider('second', 10, [
    makeResult('apps', 'same', 'Drugi'),
  ]));

  const response = await registry.search('same');
  assertEqual(response.results.length, 1);
  assertEqual(response.results[0].title, 'Pierwszy');
  assertEqual(response.stats.total, 1);
});

test('limit caps the total result count and sets truncated', async () => {
  const registry = new DaemonRegistry();
  const results = Array.from({ length: 12 }, (_, index) =>
    makeResult('many', `r${index}`, `Spot ${index}`));
  registry.register(makeProvider('many', 10, results));

  const response = await registry.search('spot', { limit: 5 });

  assertEqual(response.results.length, 5);
  assertEqual(response.stats.total, 12);
  assertTrue(response.stats.truncated);
});

test('perProviderLimit caps each section before the total limit', async () => {
  const registry = new DaemonRegistry();
  registry.register(makeProvider('alpha', 10, [
    makeResult('alpha', 'a1', 'Spot alfa 1'),
    makeResult('alpha', 'a2', 'Spot alfa 2'),
    makeResult('alpha', 'a3', 'Spot alfa 3'),
  ]));
  registry.register(makeProvider('beta', 10, [
    makeResult('beta', 'b1', 'Spot beta 1'),
    makeResult('beta', 'b2', 'Spot beta 2'),
    makeResult('beta', 'b3', 'Spot beta 3'),
  ]));

  const response = await registry.search('spot', {
    limit: 20,
    perProviderLimit: 2,
  });

  assertEqual(response.results.length, 4);
  assertEqual(response.results.filter(result => result.providerId === 'alpha').length, 2);
  assertEqual(response.results.filter(result => result.providerId === 'beta').length, 2);
  assertEqual(response.stats.total, 6);
  assertTrue(response.stats.truncated);
});

test('stats.ms contains one timing per provider that actually ran', async () => {
  const registry = new DaemonRegistry();
  registry.register(makeProvider('one', 0, [
    makeResult('one', '1', 'Spot one'),
  ]));
  registry.register(makeProvider('two', 10, [
    makeResult('two', '2', 'Spot two'),
  ]));

  const response = await registry.search('spot');

  assertEqual(Object.keys(response.stats.ms).sort().join(','), 'one,two');
  assertTrue(Number.isFinite(response.stats.ms.one));
  assertTrue(Number.isFinite(response.stats.ms.two));
});

test('a mode restricts the search to one provider', async () => {
  const registry = new DaemonRegistry();
  let appsCalled = 0;
  let settingsCalled = 0;

  registry.register(makeProvider('apps', 0, [
    makeResult('apps', 'a', 'Spotify'),
  ], {
    search: () => {
      appsCalled++;
      return [makeResult('apps', 'a', 'Spotify')];
    },
  }));
  registry.register(makeProvider('settings', 10, [
    makeResult('settings', 's', 'Spotify panel'),
  ], {
    search: () => {
      settingsCalled++;
      return [makeResult('settings', 's', 'Spotify panel')];
    },
  }));

  const response = await registry.search('spot', { mode: 'apps', limit: 8 });

  assertEqual(appsCalled, 1);
  assertEqual(settingsCalled, 0);
  assertEqual(response.results.length, 1);
  assertEqual(response.results[0].providerId, 'apps');
});

test('commands mode strips the > prefix before searching', async () => {
  const registry = new DaemonRegistry();
  let received = null;
  registry.register(makeProvider('commands', 0, [], {
    prefix: '>',
    search: query => {
      received = query;
      return [makeResult('commands', 'ls', 'Uruchom: ls')];
    },
  }));

  const response = await registry.search('>ls', { mode: 'commands' });

  assertEqual(received, 'ls');
  assertEqual(response.results.length, 1);
});

test('prefix queries still route to the matching provider', async () => {
  const registry = new DaemonRegistry();
  let plainCalled = false;
  registry.register(makeProvider('apps', 10, [], {
    search: () => {
      plainCalled = true;
      return [makeResult('apps', 'x', 'x')];
    },
  }));
  registry.register(makeProvider('commands', 0, [], {
    prefix: '>',
    search: query => [makeResult('commands', 'ls', `Uruchom: ${query}`)],
  }));

  const response = await registry.search('>ls');

  assertFalse(plainCalled);
  assertEqual(response.results.length, 1);
  assertEqual(response.results[0].providerId, 'commands');
});

test('results carry a numeric score after ranking', async () => {
  const registry = new DaemonRegistry();
  registry.register(makeProvider('apps', 10, [
    makeResult('apps', 'contains', 'xspotx'),
    makeResult('apps', 'prefix', 'spotify'),
    makeResult('apps', 'exact', 'spot'),
  ]));

  const response = await registry.search('spot', { limit: 8 });

  assertDeepEqual(
    response.results.map(result => result.id),
    ['exact', 'prefix', 'contains']
  );
  for (const result of response.results)
    assertTrue(Number.isFinite(result.score));
  assertTrue(response.results[0].score > response.results[2].score);
});

test('recent results can be looked up and activated', async () => {
  let activated = null;
  const registry = new DaemonRegistry({
    activate: result => {
      activated = result;
    },
  });
  registry.register(makeProvider('apps', 0, [
    makeResult('apps', 'spotify', 'Spotify'),
  ]));

  await registry.search('spotify');
  const result = registry.getResult('apps:spotify');
  assertTrue(result, 'result should be cached by provider:id');
  assertEqual(result.title, 'Spotify');

  assertTrue(registry.activate('apps:spotify'));
  assertEqual(activated.title, 'Spotify');
  assertFalse(registry.activate('apps:missing'));
});

test('usageMap still boosts results inside one priority', async () => {
  const registry = new DaemonRegistry();
  registry.register(makeProvider('apps', 10, [
    makeResult('apps', 'a', 'Spotify Alfa'),
    makeResult('apps', 'b', 'Spotify Beta'),
  ]));

  const response = await registry.search('spotify', {
    usageMap: { 'apps:b': { count: 3, lastUsed: 0 } },
  });

  assertDeepEqual(response.results.map(result => result.id), ['b', 'a']);
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

print(`daemon-registry: ${passed} passed, ${failed} failed`);
if (failed > 0)
  system.exit(1);