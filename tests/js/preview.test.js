import {
  test, run, assertDeepEqual, assertEqual, assertTrue, assertFalse,
} from './harness.js';
import {
  buildPreviewRows, buildPreviewModel, PREVIEW_MAX_ROWS,
} from '../../lib/ui/preview.js';

test('rows are built from [label, value] pairs', () => {
  const rows = buildPreviewRows({
    rows: [
      ['Nazwa', 'Spotify'],
      ['Typ', 'Aplikacja'],
    ],
  });

  assertDeepEqual(rows, [
    ['Nazwa', 'Spotify'],
    ['Typ', 'Aplikacja'],
  ]);
});

test('empty labels, empty values and malformed rows are skipped', () => {
  const rows = buildPreviewRows({
    rows: [
      ['Nazwa', 'Spotify'],
      ['', 'bez etykiety'],
      ['Puste', ''],
      ['Spacje', '   '],
      ['Brak wartości'],
      null,
      'nie tablica',
      ['  Typ  ', '  Aplikacja  '],
    ],
  });

  assertDeepEqual(rows, [
    ['Nazwa', 'Spotify'],
    ['Typ', 'Aplikacja'],
  ]);
});

test('the metadata table is capped at six rows', () => {
  const rows = buildPreviewRows({
    rows: Array.from({ length: 10 }, (_value, index) => [
      `Etykieta ${index}`,
      `Wartość ${index}`,
    ]),
  });

  assertEqual(PREVIEW_MAX_ROWS, 6);
  assertEqual(rows.length, 6);
  assertEqual(rows[0][0], 'Etykieta 0');
  assertEqual(rows[5][0], 'Etykieta 5');
});

test('a custom cap can be smaller than the default', () => {
  const rows = buildPreviewRows({
    rows: [
      ['A', '1'],
      ['B', '2'],
      ['C', '3'],
    ],
  }, 2);

  assertDeepEqual(rows, [['A', '1'], ['B', '2']]);
});

test('non-array input and a missing preview yield no rows', () => {
  assertDeepEqual(buildPreviewRows(null), []);
  assertDeepEqual(buildPreviewRows({}), []);
  assertDeepEqual(buildPreviewRows({ rows: 'nope' }), []);
});

test('the preview model is gated by preview-enabled', () => {
  const result = {
    title: 'Spotify',
    kind: 'Aplikacja',
    preview: { rows: [['Nazwa', 'Spotify']] },
    actions: { primary: () => {} },
  };

  assertEqual(buildPreviewModel(result, false), null);
  const model = buildPreviewModel(result, true);
  assertTrue(model !== null);
  assertEqual(model.title, 'Spotify');
  assertEqual(model.kind, 'Aplikacja');
  assertDeepEqual(model.rows, [['Nazwa', 'Spotify']]);
  assertTrue(model.primary?.callback instanceof Function);
  assertEqual(model.secondary, null);
});

test('a result without preview has no preview model', () => {
  assertEqual(buildPreviewModel({ title: 'X' }, true), null);
  assertEqual(buildPreviewModel(null, true), null);
});

test('the model accepts callback objects for primary and secondary actions', () => {
  const primary = () => {};
  const secondary = () => {};
  const model = buildPreviewModel({
    title: 'Plik',
    preview: { rows: [] },
    actions: {
      primary,
      secondary: { callback: secondary, label: 'Kopiuj ścieżkę' },
    },
  }, true);

  assertEqual(model.primary.callback, primary);
  assertEqual(model.secondary.callback, secondary);
  assertEqual(model.secondary.label, 'Kopiuj ścieżkę');
  assertFalse(model.rows.length > 0);
});

run('preview.test.js');