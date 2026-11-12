import {
  test, run, assert, assertGreater, assertLess, assertEqual,
} from './harness.js';
import { scorePathMatch } from '../../lib/ranking.js';

const HOME = '/home/anna';

function score(query, path, extra = {}) {
  return scorePathMatch(query, { path, homeDir: HOME, ...extra });
}

test('basename match earns the full title weight', () => {
  assertGreater(score('DESIGN', '/home/anna/Dokumenty/DESIGN.md'), 0);
});

test('exact basename beats a basename prefix', () => {
  const exact = score('design', '/home/anna/Dokumenty/design');
  const prefix = score('design', '/home/anna/Dokumenty/design-notes.md');
  assertGreater(exact, prefix);
});

test('a directory match is positive but weighs less than the basename', () => {
  const byBasename = score('Projekty', '/home/anna/Dokumenty/Projekty');
  const byDirectory = score('Projekty', '/home/anna/Projekty/notatki.txt');
  assertGreater(byDirectory, 0);
  assertLess(byDirectory, byBasename);
});

test('path-only match loses to a basename match', () => {
  const pathOnly = score('design', '/home/anna/design/notes.txt');
  const basename = score('design', '/home/anna/dokumenty/design-notes.pdf');
  assertGreater(basename, pathOnly);
});

test('the exact P2e scenario: docs/DESIGN.md beats the Bottles DLL', () => {
  const docs = score(
    'DESIGN',
    '/home/anna/Projekty/Gnome-Spotlight/docs/DESIGN.md'
  );
  const bottles = score(
    'DESIGN',
    '/home/anna/BottlesShare/Elden-2/drive_c/windows/mono/lib/mono/4.5/Facades/System.Drawing.Design.dll'
  );
  assertGreater(docs, bottles);
});

test('the first segment below $HOME gets a relevance bonus', () => {
  const project = score('Projekty', '/home/anna/Projekty/README.md');
  const bottles = score(
    'Projekty',
    '/home/anna/BottlesShare/drive_c/Projekty/README.md'
  );
  assertGreater(project, bottles);
});

test('a deeper path is penalised when everything else is equal', () => {
  const shallow = score('raport', '/home/anna/raport.txt');
  const deep = score('raport', '/home/anna/a/b/raport.txt');
  assertGreater(shallow, deep);
});

test('the depth penalty is capped at 12 separators', () => {
  const path = '/home/anna/raport.txt';
  assertEqual(
    score('raport', path, { depth: 12 }),
    score('raport', path, { depth: 50 })
  );
});

test('the caller-provided depth overrides the derived depth', () => {
  const path = '/home/anna/a/raport.txt';
  const shallow = score('raport', path, { depth: 0 });
  const deep = score('raport', path, { depth: 8 });
  assertGreater(shallow, deep);
});

test('an otherwise exact tie goes to the shorter path', () => {
  const short = score('raport', '/home/anna/aa/raport.txt');
  const long = score('raport', '/home/anna/aaaaaaaaaa/raport.txt');
  assertGreater(short, long);
});

test('directory names above $HOME do not match', () => {
  assertEqual(score('anna', '/home/anna/readme.md'), 0);
});

test('a non-matching path scores zero', () => {
  assertEqual(score('zzz', '/home/anna/Projekty/DESIGN.md'), 0);
});

test('an empty query scores zero', () => {
  assertEqual(score('', '/home/anna/Projekty/DESIGN.md'), 0);
});

run('ranking-path.test.js');