import {
  test, run, assert, assertEqual, assertDeepEqual,
} from './harness.js';
import {
  capRemoteResults,
  selectRemoteCandidates,
} from '../../lib/remote-candidates.js';

const NOW = 1_700_000_000_000;

function provider(busName, extra = {}) {
  return {
    busName,
    objectPath: `/org/gnome/${busName.replace(/\./g, '/')}/SearchProvider`,
    autoStart: false,
    ...extra,
  };
}

test('only providers with a bus owner are selected', () => {
  const owned = provider('org.gnome.Settings.SearchProvider');
  const missing = provider('org.gnome.Calendar');
  const selected = selectRemoteCandidates({
    owners: new Set([owned.busName]),
    providers: [owned, missing],
    limit: 3,
    now: NOW,
  });

  assertDeepEqual(selected, [owned]);
});

test('owner map values and missing keys are honoured', () => {
  const a = provider('a.SearchProvider');
  const b = provider('b.SearchProvider');
  const c = provider('c.SearchProvider');
  const selected = selectRemoteCandidates({
    owners: { [a.busName]: true, [b.busName]: false },
    providers: [a, b, c],
    limit: 3,
    now: NOW,
  });

  assertDeepEqual(selected, [a]);
});

test('AutoStart=true never bypasses the owner check', () => {
  const autoStart = provider('org.gnome.Software', { autoStart: true });
  const selected = selectRemoteCandidates({
    owners: {},
    providers: [autoStart],
    limit: 3,
    now: NOW,
  });

  assertDeepEqual(selected, []);
});

test('candidate order is the discovery order', () => {
  const providers = [
    provider('z.SearchProvider'),
    provider('a.SearchProvider'),
    provider('m.SearchProvider'),
  ];
  const selected = selectRemoteCandidates({
    owners: new Set(providers.map(item => item.busName)),
    providers,
    limit: 3,
    now: NOW,
  });

  assertDeepEqual(selected, providers);
});

test('candidate limit caps how many providers are queried', () => {
  const providers = [
    provider('one.SearchProvider'),
    provider('two.SearchProvider'),
    provider('three.SearchProvider'),
    provider('four.SearchProvider'),
  ];
  const selected = selectRemoteCandidates({
    owners: new Set(providers.map(item => item.busName)),
    providers,
    limit: 2,
    now: NOW,
  });

  assertDeepEqual(selected, providers.slice(0, 2));
});

test('a stale owner record expires against now', () => {
  const fresh = provider('fresh.SearchProvider');
  const stale = provider('stale.SearchProvider');
  const selected = selectRemoteCandidates({
    owners: {
      [fresh.busName]: { hasOwner: true, expiresAt: NOW + 1000 },
      [stale.busName]: { hasOwner: true, expiresAt: NOW - 1 },
    },
    providers: [fresh, stale],
    limit: 3,
    now: NOW,
  });

  assertDeepEqual(selected, [fresh]);
});

test('a provider in failure cooldown is skipped', () => {
  const cooling = provider('cooling.SearchProvider', { blockedUntil: NOW + 5000 });
  const ready = provider('ready.SearchProvider');
  const selected = selectRemoteCandidates({
    owners: new Set([cooling.busName, ready.busName]),
    providers: [cooling, ready],
    limit: 3,
    now: NOW,
  });

  assertDeepEqual(selected, [ready]);
});

test('capRemoteResults returns at most three results', () => {
  const results = Array.from({ length: 6 }, (_value, index) => ({
    id: `org.gnome.Test:${index}`,
    remote: { busName: 'org.gnome.Test', remoteId: String(index) },
    title: `Result ${index}`,
    score: 100 - index,
  }));

  const capped = capRemoteResults(results, 3);

  assertEqual(capped.length, 3);
  assertDeepEqual(capped.map(result => result.title), ['Result 0', 'Result 1', 'Result 2']);
});

test('capRemoteResults sorts by score before applying the cap', () => {
  const results = [
    { busName: 'b', remoteId: '1', title: 'Low', score: 1 },
    { busName: 'a', remoteId: '1', title: 'High', score: 9 },
    { busName: 'c', remoteId: '1', title: 'Mid', score: 5 },
  ];

  assertDeepEqual(
    capRemoteResults(results, 2).map(result => result.title),
    ['High', 'Mid']
  );
});

test('capRemoteResults dedupes by busName and remoteId', () => {
  const results = [
    { busName: 'org.gnome.Software', remoteId: 'same', title: 'First', score: 1 },
    { busName: 'org.gnome.Software', remoteId: 'same', title: 'Better', score: 9 },
    { busName: 'org.gnome.Settings', remoteId: 'same', title: 'Other', score: 5 },
    { busName: 'org.gnome.Software', remoteId: 'other', title: 'Third', score: 3 },
  ];

  assertDeepEqual(
    capRemoteResults(results, 3).map(result => result.title),
    ['Better', 'Other', 'Third']
  );
});

test('capRemoteResults keeps flat ids and does not mutate the input', () => {
  const results = [
    {
      id: 'org.gnome.Calculator.SearchProvider:1+1',
      busName: 'org.gnome.Calculator.SearchProvider',
      remoteId: '1+1',
      title: 'Calculator',
      score: 2,
    },
  ];
  const snapshot = results.map(result => ({ ...result }));

  const capped = capRemoteResults(results, 3);

  assertEqual(capped.length, 1);
  assertEqual(capped[0].title, 'Calculator');
  assertDeepEqual(results, snapshot);
});

test('capRemoteResults tolerates malformed entries', () => {
  const results = [
    null,
    {},
    { id: 'x:1', title: 'X', score: 'not-a-number' },
    { id: 'x:1', title: 'X duplicate', score: 0 },
  ];

  const capped = capRemoteResults(results, 3);

  assertEqual(capped.length, 1);
  assertEqual(capped[0].title, 'X');
});

run('remote-budget.test.js');
