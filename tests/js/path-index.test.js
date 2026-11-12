import {
  test, run, assert, assertEqual, assertTrue, assertFalse, assertGreater,
} from './harness.js';
import {
  DEFAULT_MAX_ENTRIES,
  EXCLUDED_SEGMENTS,
  MAX_FILE_SIZE,
  PathIndex,
} from '../../lib/path-index.js';

const HOME = '/home/anna';

test('add stores a path and a basename-prefix search ranks it first', () => {
  const index = new PathIndex();
  const path = `${HOME}/Projects/Gnome-Spotlight/docs/DESIGN.md`;

  assertTrue(index.add(path));
  assertEqual(index.size, 1);

  const [first] = index.search('DESIGN');
  assertEqual(first.path, path);
  assertEqual(first.name, 'DESIGN.md');
  assertEqual(first.score, 3);
  assertFalse(first.isDirectory);
});

test('search is case-insensitive and folds Polish diacritics', () => {
  const index = new PathIndex();
  const path = `${HOME}/Dokumenty/Raport-Łódź.txt`;
  index.add(path);

  assertEqual(index.search('raport-lodz')[0].path, path);
  assertEqual(index.search('RAPORT-ŁÓDŹ')[0].path, path);
});

test('basename prefix beats basename contains', () => {
  const index = new PathIndex();
  index.add(`${HOME}/Dokumenty/stary-design-notatki.md`);
  index.add(`${HOME}/Dokumenty/Design-notes.md`);

  const results = index.search('design');
  assertEqual(results[0].name, 'Design-notes.md');
  assertEqual(results[0].score, 3);
  assertEqual(results[1].score, 2);
});

test('basename contains beats a directory-segment match', () => {
  const index = new PathIndex();
  index.add(`${HOME}/Projects/design/readme.txt`);
  index.add(`${HOME}/Projects/logo-design.png`);

  const results = index.search('design');
  assertEqual(results[0].name, 'logo-design.png');
  assertEqual(results[0].score, 2);
  assertEqual(results[1].score, 1);
});

test('a query can match a directory segment', () => {
  const index = new PathIndex();
  const path = `${HOME}/Projects/Budzet/notatki.txt`;
  index.add(path);

  const results = index.search('budzet');
  assertEqual(results.length, 1);
  assertEqual(results[0].path, path);
  assertEqual(results[0].score, 1);
});

test('search honours the limit', () => {
  const index = new PathIndex();
  for (let number = 1; number <= 5; number++)
    index.add(`${HOME}/Dokumenty/raport-${number}.txt`);

  assertEqual(index.search('raport', 2).length, 2);
  assertEqual(index.search('raport', 0).length, 0);
});

test('remove deletes a path and reports whether it existed', () => {
  const index = new PathIndex();
  const path = `${HOME}/Projects/README.md`;
  index.add(path);

  assertTrue(index.remove(path));
  assertEqual(index.size, 0);
  assertFalse(index.remove(path));
  assertFalse(index.has(path));
});

test('excluded directories are never indexed', () => {
  const index = new PathIndex();
  for (const segment of EXCLUDED_SEGMENTS) {
    assertFalse(
      index.add(`${HOME}/Projects/${segment}/plik.js`),
      `${segment} must be excluded`
    );
    assertFalse(index.add(`${HOME}/${segment}`));
  }
  assertEqual(index.size, 0);
  assertEqual(index.search('plik').length, 0);
});

test('files larger than 5 MB are rejected, the boundary is accepted', () => {
  const index = new PathIndex();

  assertTrue(index.add(`${HOME}/Dokumenty/granica.bin`, { size: MAX_FILE_SIZE }));
  assertFalse(index.add(`${HOME}/Dokumenty/duzy.bin`, {
    size: MAX_FILE_SIZE + 1,
  }));
  assertEqual(index.size, 1);
  assertTrue(index.has(`${HOME}/Dokumenty/granica.bin`));
});

test('a directory is accepted even when its stat size is large', () => {
  const index = new PathIndex();
  const path = `${HOME}/Projects/node_modules-free`;

  assertTrue(index.add(path, {
    isDirectory: true,
    size: MAX_FILE_SIZE * 10,
  }));
  assertTrue(index.search('node_modules-free')[0].isDirectory);
});

test('add accepts an object and keeps stat metadata', () => {
  const index = new PathIndex();
  const path = `${HOME}/Projects/raport.txt`;

  assertTrue(index.add({
    path,
    size: 1234,
    mtime: 1700000000000,
  }));

  const [result] = index.search('raport');
  assertEqual(result.path, path);
  assertEqual(result.size, 1234);
  assertEqual(result.modified, 1700000000000);
});

test('the default entry cap is 200 000', () => {
  const index = new PathIndex();
  assertEqual(DEFAULT_MAX_ENTRIES, 200000);
  assertEqual(index.maxEntries, DEFAULT_MAX_ENTRIES);
});

test('add automatically keeps the index within maxEntries', () => {
  const index = new PathIndex({ maxEntries: 3 });
  for (let number = 1; number <= 5; number++)
    index.add(`${HOME}/Dokumenty/plik-${number}.txt`);

  assertEqual(index.size, 3);
  assertFalse(index.has(`${HOME}/Dokumenty/plik-1.txt`));
  assertFalse(index.has(`${HOME}/Dokumenty/plik-2.txt`));
  assertTrue(index.has(`${HOME}/Dokumenty/plik-5.txt`));
});

test('prune removes the oldest entries and returns the count', () => {
  const index = new PathIndex({ maxEntries: 10 });
  for (let number = 1; number <= 5; number++)
    index.add(`${HOME}/Dokumenty/prune-${number}.txt`);

  assertEqual(index.prune(2), 3);
  assertEqual(index.size, 2);
  assertFalse(index.has(`${HOME}/Dokumenty/prune-3.txt`));
  assertTrue(index.has(`${HOME}/Dokumenty/prune-4.txt`));
  assertTrue(index.has(`${HOME}/Dokumenty/prune-5.txt`));
  assertEqual(index.prune(10), 0);
});

test('serialize/parse preserves entries and the entry cap', () => {
  const index = new PathIndex({ maxEntries: 7 });
  const file = `${HOME}/Projects/raport-2024.txt`;
  const directory = `${HOME}/Projects/Budzet`;
  index.add(file, { size: 99, modified: 123 });
  index.add(directory, { isDirectory: true });

  const parsed = PathIndex.parse(index.serialize());
  assertEqual(parsed.maxEntries, 7);
  assertEqual(parsed.size, 2);

  const [result] = parsed.search('raport');
  assertEqual(result.path, file);
  assertEqual(result.size, 99);
  assertEqual(result.modified, 123);
  assertTrue(parsed.search('budzet')[0].isDirectory);
});

test('parse tolerates empty, truncated and non-object input', () => {
  for (const value of ['', '   ', '{not json', '{"entries":', null,
    undefined, 42, true]) {
    const index = PathIndex.parse(value);
    assertEqual(index.size, 0);
  }
});

test('adding the same path twice updates metadata without growing', () => {
  const index = new PathIndex();
  const path = `${HOME}/Dokumenty/ten-sam.txt`;

  index.add(path, { size: 10 });
  index.add(path, { size: 20 });

  assertEqual(index.size, 1);
  assertEqual(index.search('ten-sam')[0].size, 20);
});

test('an empty query or an empty path is a no-op', () => {
  const index = new PathIndex();
  assertFalse(index.add('   '));
  assertEqual(index.size, 0);
  assertEqual(index.search('').length, 0);
  assertEqual(index.search('   ').length, 0);
});

run('path-index.test.js');