import system from 'system';

import {
  assert, assertDeepEqual, assertEqual, assertFalse, assertTrue,
} from './harness.js';
import { ClipboardStore, hashText } from '../../lib/clipboard-store.js';
import {
  createProvider,
  parseClipboardQuery,
} from '../../lib/providers/clipboard.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const cases = [];
let passed = 0;
let failed = 0;

function test(name, fn) {
  cases.push({ name, fn });
}

function ids(store) {
  return store.list().map(entry => entry.id);
}

test('add stores text, mime, count and lastUsed', () => {
  const store = new ClipboardStore({ now: () => 5000 });
  const entry = store.add({ text: 'hello', mime: 'text/plain' });

  assertTrue(entry, 'add returned no entry');
  assertEqual(entry.text, 'hello');
  assertEqual(entry.mime, 'text/plain');
  assertEqual(entry.count, 1);
  assertEqual(entry.lastUsed, 5000);
  assertTrue(/^[0-9a-f]{8}$/.test(entry.id), entry.id);
  assertEqual(store.list().length, 1);
});

test('the id is a stable 8-hex hash of the content', () => {
  const first = new ClipboardStore({ now: () => 1 });
  const second = new ClipboardStore({ now: () => 99 });
  const a = first.add({ text: 'identyczne' });
  const b = second.add({ text: 'identyczne' });
  const c = second.add({ text: 'inne' });

  assertEqual(a.id, b.id);
  assertEqual(a.id, hashText('identyczne'));
  assertTrue(/^[0-9a-f]{8}$/.test(c.id));
  assertFalse(a.id === c.id, 'different text must not share the id');
});

test('re-adding the same text moves it to the front and bumps count', () => {
  let now = 1000;
  const store = new ClipboardStore({ now: () => now });

  store.add({ text: 'pierwszy' });
  now = 2000;
  store.add({ text: 'drugi' });
  now = 3000;
  const entry = store.add({ text: 'pierwszy', mime: 'text/html' });

  assertEqual(entry.count, 2);
  assertEqual(entry.lastUsed, 3000);
  assertEqual(entry.mime, 'text/html');
  assertDeepEqual(store.list().map(item => item.text), ['pierwszy', 'drugi']);
  assertEqual(store.list().length, 2);
});

test('list returns newest first', () => {
  let now = 0;
  const store = new ClipboardStore({ now: () => ++now });
  store.add({ text: 'a' });
  store.add({ text: 'b' });
  store.add({ text: 'c' });

  assertDeepEqual(store.list().map(entry => entry.text), ['c', 'b', 'a']);
});

test('remove drops exactly one entry by id', () => {
  const store = new ClipboardStore({ now: () => 1 });
  const first = store.add({ text: 'a' });
  store.add({ text: 'b' });

  assertTrue(store.remove(first.id));
  assertFalse(store.remove(first.id));
  assertDeepEqual(store.list().map(entry => entry.text), ['b']);
  assertFalse(store.remove(''), 'empty id must be a no-op');
});

test('clear removes every entry', () => {
  const store = new ClipboardStore({ now: () => 1 });
  store.add({ text: 'a' });
  store.add({ text: 'b' });
  store.clear();

  assertEqual(store.list().length, 0);
  assertEqual(store.size, 0);
});

test('the default limit trims history to 100 newest entries', () => {
  let now = 0;
  const store = new ClipboardStore({ now: () => ++now });
  for (let index = 0; index < 120; index++)
    store.add({ text: `wpis-${index}` });

  const list = store.list();
  assertEqual(list.length, 100);
  assertEqual(list[0].text, 'wpis-119');
  assertEqual(list[99].text, 'wpis-20');
  assertEqual(store.size, 100);
});

test('a custom limit is enforced after every add', () => {
  let now = 0;
  const store = new ClipboardStore({ now: () => ++now, limit: 3 });
  for (const text of ['a', 'b', 'c', 'd'])
    store.add({ text });

  assertDeepEqual(store.list().map(entry => entry.text), ['d', 'c', 'b']);
});

test('texts larger than 64 KiB are skipped', () => {
  const store = new ClipboardStore({ now: () => 1 });
  assertEqual(store.add({ text: 'a'.repeat(65537) }), null);
  assertEqual(store.list().length, 0);

  const accepted = store.add({ text: 'b'.repeat(65536) });
  assertTrue(accepted, 'exactly maxBytes should be accepted');
  assertEqual(store.list().length, 1);
});

test('maxBytes is measured in UTF-8 bytes and can be configured', () => {
  const store = new ClipboardStore({ now: () => 1, maxBytes: 4 });
  assertTrue(store.add({ text: 'abcd' }));
  assertEqual(store.add({ text: 'abcde' }), null);
  assertEqual(store.add({ text: 'żółć' }), null, '8 UTF-8 bytes > 4');
  assertEqual(store.list().length, 1);
});

test('empty and non-string texts are ignored', () => {
  const store = new ClipboardStore({ now: () => 1 });
  assertEqual(store.add({ text: '' }), null);
  assertEqual(store.add({ text: null }), null);
  assertEqual(store.add({}), null);
  assertEqual(store.add(null), null);
  assertEqual(store.list().length, 0);
});

test('entries expire after 7 days from lastUsed', () => {
  let now = 1_000_000;
  const store = new ClipboardStore({ now: () => now });
  store.add({ text: 'stary' });

  now += 7 * DAY_MS - 1;
  assertEqual(store.list().length, 1, 'just below TTL must survive');
  now += 1;
  assertEqual(store.list().length, 0, 'exactly 7 days must expire');
});

test('re-adding refreshes the TTL', () => {
  let now = 0;
  const store = new ClipboardStore({ now: () => now });
  store.add({ text: 'odświeżany' });

  now = 6 * DAY_MS;
  store.add({ text: 'odświeżany' });
  now = 12 * DAY_MS;
  assertEqual(store.list().length, 1);
  assertEqual(store.list()[0].count, 2);
});

test('re-adding expired text starts a fresh entry', () => {
  let now = 0;
  const store = new ClipboardStore({ now: () => now });
  store.add({ text: 'wygasły' });
  store.add({ text: 'wygasły' });

  now = 8 * DAY_MS;
  const entry = store.add({ text: 'wygasły' });

  assertEqual(entry.count, 1);
  assertEqual(store.list().length, 1);
  assertEqual(store.list()[0].lastUsed, 8 * DAY_MS);
});

test('corrupted JSON degrades to an empty store', () => {
  for (const input of ['', '{', 'null', '[]', '42', '"text"', undefined]) {
    const store = ClipboardStore.parse(input);
    assertEqual(store.list().length, 0, `input ${String(input)}`);
    assertEqual(store.serialize(), '{"version":1,"entries":[]}');
  }
});

test('serialize round-trips entries, order and counters', () => {
  let now = 100;
  const store = new ClipboardStore({ now: () => now });
  store.add({ text: 'pierwszy' });
  now = 200;
  store.add({ text: 'drugi' });
  now = 300;
  store.add({ text: 'pierwszy' });

  const restored = ClipboardStore.parse(store.serialize(), { now: () => 400 });
  const list = restored.list();

  assertDeepEqual(list.map(entry => entry.text), ['pierwszy', 'drugi']);
  assertDeepEqual(list.map(entry => entry.count), [2, 1]);
  assertDeepEqual(ids(restored), ids(store));
});

test('parse tolerates a bare array and recomputes missing ids', () => {
  const store = ClipboardStore.parse(JSON.stringify([
    { text: 'bez id', count: 3, lastUsed: 500 },
  ]), { now: () => 1000 });

  const list = store.list();
  assertEqual(list.length, 1);
  assertEqual(list[0].id, hashText('bez id'));
  assertEqual(list[0].count, 3);
});

test('invalid entries and oversized entries are dropped during parse', () => {
  const store = ClipboardStore.parse(JSON.stringify({
    version: 1,
    entries: [
      { text: 'ok', count: 2, lastUsed: 500 },
      { text: 42 },
      { text: '' },
      { text: 'x'.repeat(65537) },
      null,
      { text: 'ok2', count: -1, lastUsed: 400 },
    ],
  }), { now: () => 1000 });

  const list = store.list();
  assertDeepEqual(list.map(entry => entry.text), ['ok', 'ok2']);
  assertEqual(list[0].count, 2);
  assertEqual(list[1].count, 1, 'invalid count falls back to 1');
});

test('duplicate texts in JSON are merged by content', () => {
  const store = ClipboardStore.parse(JSON.stringify({
    entries: [
      { text: 'ten sam', count: 1, lastUsed: 100 },
      { text: 'ten sam', count: 2, lastUsed: 200 },
    ],
  }), { now: () => 300 });

  assertEqual(store.list().length, 1);
  assertEqual(store.list()[0].count, 3);
  assertEqual(store.list()[0].lastUsed, 200);
});

test('parse applies the TTL with the injected clock', () => {
  const serialized = JSON.stringify({
    entries: [{ text: 'stary', count: 1, lastUsed: 1 }],
  });

  assertEqual(ClipboardStore.parse(serialized, { now: () => 2 }).list().length, 1);
  assertEqual(
    ClipboardStore.parse(serialized, { now: () => 1 + 7 * DAY_MS }).list().length,
    0
  );
});

test('list returns independent copies', () => {
  const store = new ClipboardStore({ now: () => 1 });
  store.add({ text: 'a' });
  const copy = store.list()[0];
  copy.text = 'zmienione';
  copy.count = 99;

  assertEqual(store.list()[0].text, 'a');
  assertEqual(store.list()[0].count, 1);
});

test('parseClipboardQuery recognises cb and clip spellings', () => {
  assertDeepEqual(parseClipboardQuery('cb '), { active: true, needle: '' });
  assertDeepEqual(parseClipboardQuery('cb raport'), { active: true, needle: 'raport' });
  assertDeepEqual(parseClipboardQuery('clip'), { active: true, needle: '' });
  assertDeepEqual(parseClipboardQuery('clipboard mail'), {
    active: true,
    needle: 'mail',
  });
  assertDeepEqual(parseClipboardQuery('spotify'), { active: false, needle: '' });
  assertDeepEqual(parseClipboardQuery('c'), { active: false, needle: '' });
});

test('provider capture reads the clipboard once and search maps an entry', async () => {
  let clipboardText = 'pierwsza linia\ndruga linia';
  const clipboard = {
    get_text: () => clipboardText,
    set_text: value => {
      clipboardText = value;
    },
  };
  const store = new ClipboardStore({ now: () => 1000 });
  const provider = createProvider({
    store,
    clipboard,
    cachePath: null,
    now: () => 1000,
  });

  await provider.capture();
  const results = await provider.search('cb ', { limit: 8 });

  assertEqual(results.length, 1);
  assertEqual(results[0].title, 'pierwsza linia');
  assertEqual(results[0].kind, 'Schowek');
  assertEqual(results[0].providerId, 'clipboard');
  assertTrue(results[0].subtitle.startsWith('schowek · '), results[0].subtitle);
  assertTrue(results[0].subtitle.endsWith('· 1×'), results[0].subtitle);

  await results[0].actions.primary();
  assertEqual(clipboardText, 'pierwsza linia\ndruga linia');

  results[0].actions.secondary();
  assertEqual(store.list().length, 0);
  assertEqual((await provider.search('cb ', { limit: 8 })).length, 0);
});

test('provider title is the first line capped at 80 characters', async () => {
  const store = new ClipboardStore({ now: () => 1 });
  store.add({ text: `${'x'.repeat(120)}\nreszta` });
  const provider = createProvider({ store, clipboard: null, cachePath: null, now: () => 1 });

  const [result] = await provider.search('cb ', { limit: 8 });
  assertEqual(result.title.length, 80);
  assertTrue(result.title.endsWith('…'));
});

test('provider filters, sorts by lastUsed and caps the result list at 8', async () => {
  let now = 0;
  const store = new ClipboardStore({ now: () => now });
  for (let index = 0; index < 12; index++) {
    now++;
    store.add({ text: `notatka ${index}` });
  }
  store.add({ text: 'inny tekst' });
  const provider = createProvider({ store, clipboard: null, cachePath: null, now: () => now });

  const all = await provider.search('clip', { limit: 100 });
  assertEqual(all.length, 8);
  assertEqual(all[0].title, 'inny tekst');

  now++;
  store.add({ text: 'notatka 3' });
  const filtered = await provider.search('cb notatka 3', { limit: 8 });
  assertEqual(filtered.length, 1);
  assertEqual(filtered[0].title, 'notatka 3');

  const inactive = await provider.search('spotify', { limit: 8 });
  assertEqual(inactive.length, 0);
});

test('provider does not capture on ordinary queries', async () => {
  let reads = 0;
  const clipboard = {
    get_text: () => {
      reads++;
      return 'nieczytane';
    },
  };
  const store = new ClipboardStore({ now: () => 1 });
  store.add({ text: 'historia' });
  const provider = createProvider({ store, clipboard, cachePath: null, now: () => 1 });

  assertEqual((await provider.search('spotify', { limit: 8 })).length, 0);
  assertEqual(reads, 0);
  assertEqual(store.list()[0].text, 'historia');
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

print(`clipboard-store: ${passed} passed, ${failed} failed`);
if (failed > 0)
  system.exit(1);