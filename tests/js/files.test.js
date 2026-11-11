import {
  test, run, assert, assertEqual, assertTrue, assertFalse,
} from './harness.js';
import { pathToResult } from '../../lib/providers/files.js';

const HOME = '/home/anna';

test('pathToResult sets basename, shortened path and extension', () => {
  const result = pathToResult(
    '/home/anna/Dokumenty/bardzo/dlugie/raport-2024.pdf',
    HOME,
    28
  );

  assertEqual(result.title, 'raport-2024.pdf');
  assertTrue(result.subtitle.startsWith('~/'), result.subtitle);
  assertTrue(result.subtitle.length <= 28, result.subtitle);
  assertEqual(result.kind, 'pdf');
  assertEqual(result.providerId, 'files');
  assertTrue(result.actions.primary instanceof Function);
});

test('a file without an extension gets the generic kind', () => {
  const result = pathToResult('/home/anna/README', HOME, 40);
  assertEqual(result.kind, 'Plik');
  assertEqual(result.title, 'README');
  assertFalse(result.title.includes('/'));
});

run('files.test.js');