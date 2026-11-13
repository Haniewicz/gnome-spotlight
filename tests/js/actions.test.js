import {
  test, run, assertDeepEqual, assertEqual, assertFalse, assertTrue,
} from './harness.js';
import { buildActionMenu, normalizeMenuActions } from '../../lib/ui/actions.js';

function labels(items) {
  return items.map(item => item.label);
}

test('menu model preserves provider order', () => {
  const result = {
    actions: {
      menu: [
        { id: 'reveal', label: 'Pokaż w plikach', callback: () => {} },
        { id: 'copy', label: 'Kopiuj ścieżkę', callback: () => {} },
        { id: 'terminal', label: 'Uruchom w terminalu', callback: () => {} },
      ],
    },
  };

  assertDeepEqual(labels(buildActionMenu(result)), [
    'Pokaż w plikach',
    'Kopiuj ścieżkę',
    'Uruchom w terminalu',
  ]);
});

test('a declarative descriptor without a callback stays enabled', () => {
  const items = buildActionMenu({
    actions: {
      menu: [
        { id: 'launch', type: 'app', label: 'Uruchom', appId: 'org.gnome.Settings' },
        { id: 'copy', label: 'Kopiuj', callback: () => {} },
        { id: 'disabled', label: 'Wyłączona', disabled: true },
        { id: 'off', label: 'Wyłączona 2', enabled: false },
      ],
    },
  });

  assertEqual(items.length, 4);
  assertFalse(items[0].disabled);
  assertEqual(items[0].descriptor.type, 'app');
  assertFalse(items[1].disabled);
  assertTrue(items[2].disabled);
  assertTrue(items[3].disabled);
});

test('enabled:false disables an otherwise executable descriptor', () => {
  const items = buildActionMenu({
    actions: {
      menu: [
        { id: 'tile-left', type: 'app', label: 'Przytnij w lewo', enabled: true },
        { id: 'close', type: 'app', label: 'Zamknij', enabled: false },
      ],
    },
  });

  assertEqual(items.length, 2);
  assertFalse(items[0].disabled);
  assertTrue(items[1].disabled);
});

test('actions wrapped in a Variant with a JSON string are parsed', () => {
  class FakeVariant {
    constructor(value) {
      this.value = value;
    }

    deepUnpack() {
      return this.value;
    }
  }

  const actions = JSON.stringify({
    menu: [
      { id: 'launch', type: 'app', label: 'Uruchom' },
      { id: 'copy-path', type: 'copy', label: 'Kopiuj ścieżkę' },
    ],
  });
  const items = buildActionMenu({ actions: new FakeVariant(actions) });

  assertDeepEqual(labels(items), ['Uruchom', 'Kopiuj ścieżkę']);
  assertEqual(items[0].descriptor.type, 'app');
  assertFalse(items[0].disabled);
});

test('a function entry is disabled because it has no label', () => {
  const items = buildActionMenu({ actions: { menu: [() => {}] } });
  assertEqual(items.length, 0);
});

test('an empty or missing menu means no menu', () => {
  assertDeepEqual(buildActionMenu({ actions: { menu: [] } }), []);
  assertDeepEqual(buildActionMenu({ actions: { menu: [] } }, { parse: r => r.actions }), []);
  assertDeepEqual(buildActionMenu({ actions: {} }), []);
  assertDeepEqual(buildActionMenu({}), []);
  assertDeepEqual(buildActionMenu(null), []);
});

test('a disabled result has no menu at all', () => {
  assertDeepEqual(buildActionMenu({
    disabled: true,
    actions: { menu: [{ label: 'Akcja', callback: () => {} }] },
  }), []);
});

test('item ids fall back to their menu position', () => {
  const items = buildActionMenu({
    actions: { menu: [{ label: 'Pierwsza', callback: () => {} }] },
  });
  assertEqual(items[0].id, 'action-0');
});

test('normalizeMenuActions is an alias of the model builder', () => {
  const result = { actions: { menu: [{ label: 'A', callback: () => {} }] } };
  assertDeepEqual(normalizeMenuActions(result), buildActionMenu(result));
});

test('null entries inside the menu are ignored without breaking order', () => {
  const result = {
    actions: {
      menu: [
        null,
        { label: 'A', callback: () => {} },
        { label: 'B', callback: () => {} },
      ],
    },
  };
  assertDeepEqual(labels(buildActionMenu(result)), ['A', 'B']);
});

run('actions.test.js');