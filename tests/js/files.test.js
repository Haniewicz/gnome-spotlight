import {
  test, run, assert, assertEqual, assertTrue, assertFalse, assertDeepEqual,
} from './harness.js';
import {
  parseLocateOutput, pathToResult,
} from '../../lib/providers/files.js';

const HOME = '/home/anna';

test('blank lines are ignored', () => {
  const paths = parseLocateOutput('\n\n/home/anna/a.txt\n   \n', 10);
  assertDeepEqual(paths, ['/home/anna/a.txt']);
});

test('spaces inside a path survive parsing', () => {
  const paths = parseLocateOutput('  /home/anna/Plik z spacjami.pdf  \n', 10);
  assertDeepEqual(paths, ['/home/anna/Plik z spacjami.pdf']);
});

test('duplicate lines are collapsed, first occurrence wins', () => {
  const paths = parseLocateOutput([
    '/home/anna/a.txt',
    '/home/anna/b.txt',
    '/home/anna/a.txt',
  ].join('\n'), 10);
  assertDeepEqual(paths, ['/home/anna/a.txt', '/home/anna/b.txt']);
});

test('junk directories are excluded', () => {
  const paths = parseLocateOutput([
    '/proc/1/status',
    '/sys/kernel/notes',
    '/dev/null',
    '/home/anna/.git/config',
    '/home/anna/project/.git/HEAD',
    '/home/anna/project/node_modules/pkg/index.js',
    '/home/anna/.cache/thumb.png',
    '/home/anna/.local/share/Trash/files/old.txt',
    '/home/anna/Dokumenty/ok.txt',
  ].join('\n'), 20);

  assertDeepEqual(paths, ['/home/anna/Dokumenty/ok.txt']);
});

test('the result limit is applied after filtering and de-duplication', () => {
  const paths = parseLocateOutput([
    '/home/anna/a.txt',
    '/home/anna/a.txt',
    '/proc/1',
    '/home/anna/b.txt',
    '/home/anna/c.txt',
  ].join('\n'), 2);

  assertDeepEqual(paths, ['/home/anna/a.txt', '/home/anna/b.txt']);
  assertEqual(parseLocateOutput('/home/anna/a.txt', 0).length, 0);
});

test('non-string output degrades to an empty list', () => {
  assertDeepEqual(parseLocateOutput(null, 5), []);
  assertDeepEqual(parseLocateOutput(undefined, 5), []);
});

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