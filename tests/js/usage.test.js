import {
  test, run, assert, assertEqual, assertDeepEqual, assertNotEqual,
} from './harness.js';
import { UsageStore } from '../../lib/usage.js';

test('parse("") returns an empty state without throwing', () => {
  const store = UsageStore.parse('');
  assertEqual(store.serialize(), '{}');
  assertDeepEqual(store.entry('anything'), { count: 0, lastUsed: 0 });
});

test('parse("{") returns an empty state without throwing', () => {
  const store = UsageStore.parse('{');
  assertEqual(store.serialize(), '{}');
});

test('parse("null") returns an empty state without throwing', () => {
  const store = UsageStore.parse('null');
  assertEqual(store.serialize(), '{}');
});

test('parse handles arrays and primitive JSON as empty', () => {
  assertEqual(UsageStore.parse('[]').serialize(), '{}');
  assertEqual(UsageStore.parse('42').serialize(), '{}');
  assertEqual(UsageStore.parse('"text"').serialize(), '{}');
  assertEqual(UsageStore.parse(undefined).serialize(), '{}');
});

test('record increases count and sets lastUsed', () => {
  const store = UsageStore.parse('{}');
  const entry = store.record('apps:spotify', 123456789);

  assertEqual(entry.count, 1);
  assertEqual(entry.lastUsed, 123456789);
  assertDeepEqual(store.entry('apps:spotify'), { count: 1, lastUsed: 123456789 });
});

test('record accumulates count and refreshes lastUsed', () => {
  const store = UsageStore.parse('{}');
  store.record('apps:spotify', 1000);
  store.record('apps:spotify', 2000);
  store.record('apps:spotify', 3000);

  assertDeepEqual(store.entry('apps:spotify'), { count: 3, lastUsed: 3000 });
});

test('serialize round-trips through parse', () => {
  const store = UsageStore.parse('{}');
  store.record('apps:spotify', 111);
  store.record('apps:spotify', 222);
  store.record('files:doc', 333);

  const restored = UsageStore.parse(store.serialize());
  assertDeepEqual(restored.entry('apps:spotify'), { count: 2, lastUsed: 222 });
  assertDeepEqual(restored.entry('files:doc'), { count: 1, lastUsed: 333 });
});

test('UsageStore loads from and persists to injected storage', () => {
  let saved = null;
  const storage = {
    get: () => '{"apps:spotify":{"count":2,"lastUsed":10}}',
    set: value => {
      saved = value;
    },
  };

  const store = new UsageStore(storage);
  assertDeepEqual(store.entry('apps:spotify'), { count: 2, lastUsed: 10 });

  store.record('apps:spotify', 20);
  assertDeepEqual(store.entry('apps:spotify'), { count: 3, lastUsed: 20 });
  assertNotEqual(saved, null);
  assertEqual(saved, store.serialize());
});

test('corrupted storage JSON degrades to an empty store', () => {
  const store = new UsageStore({ get: () => '{not json', set: () => {} });
  assertEqual(store.serialize(), '{}');
});

test('throwing storage get/set never escapes', () => {
  const store = new UsageStore({
    get: () => {
      throw new Error('boom');
    },
    set: () => {
      throw new Error('boom');
    },
  });
  assertEqual(store.serialize(), '{}');
  assertEqual(store.record('apps:x', 5).count, 1);
});

test('invalid entries are dropped during parse', () => {
  const store = UsageStore.parse(JSON.stringify({
    valid: { count: 3, lastUsed: 99 },
    nullEntry: null,
    arrayEntry: [1, 2],
    stringEntry: 'nope',
    badNumbers: { count: 'x', lastUsed: {} },
  }));

  assertDeepEqual(store.entry('valid'), { count: 3, lastUsed: 99 });
  assertDeepEqual(store.entry('nullEntry'), { count: 0, lastUsed: 0 });
  assertDeepEqual(store.entry('arrayEntry'), { count: 0, lastUsed: 0 });
  assertDeepEqual(store.entry('stringEntry'), { count: 0, lastUsed: 0 });
  assertDeepEqual(store.entry('badNumbers'), { count: 0, lastUsed: 0 });
});

test('record with an empty key is a no-op', () => {
  const store = UsageStore.parse('{}');
  const entry = store.record('', 100);
  assertEqual(entry.count, 0);
  assertEqual(store.serialize(), '{}');
});

test('entry returns an independent copy', () => {
  const store = UsageStore.parse('{"a":{"count":1,"lastUsed":2}}');
  const entry = store.entry('a');
  entry.count = 99;
  assertEqual(store.entry('a').count, 1);
});

test('static parse result has the UsageStore API', () => {
  const store = UsageStore.parse('{}');
  assert(typeof store.record === 'function');
  assert(typeof store.entry === 'function');
  assert(typeof store.serialize === 'function');
});

run('usage.test.js');