import {
  test, run, assertDeepEqual, assertEqual,
} from './harness.js';
import { parseLocateOutput } from '../../lib/files-parse.js';

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

run('files-parse.test.js');