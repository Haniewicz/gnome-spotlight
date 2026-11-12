import {
  test, run, assert, assertEqual, assertTrue, assertFalse,
} from './harness.js';
import {
  buildSearchQuery,
  mapRow,
  sanitizeTerm,
} from '../../lib/tracker-query.js';

test('sanitizeTerm removes control characters', () => {
  assertEqual(sanitizeTerm('ra\u0000port\t2024\n'), 'ra port 2024');
});

test('sanitizeTerm trims the term to 64 characters', () => {
  const value = sanitizeTerm('a'.repeat(120));
  assertEqual(value.length, 64);
  assertEqual(value, 'a'.repeat(64));
});

test('sanitizeTerm tolerates null and non-string values', () => {
  assertEqual(sanitizeTerm(null), '');
  assertEqual(sanitizeTerm(undefined), '');
  assertEqual(sanitizeTerm(42), '42');
});

test('buildSearchQuery defaults to LIMIT 8', () => {
  const query = buildSearchQuery('raport');
  assertTrue(query.includes('LIMIT 8'), query);
});

test('buildSearchQuery injects an integer limit', () => {
  const query = buildSearchQuery('raport', { limit: 5 });
  assertTrue(query.includes('LIMIT 5'), query);
  assertFalse(query.includes('LIMIT 5.0'), query);
});

test('buildSearchQuery rejects non-integer limits', () => {
  for (const limit of [3.5, '8', NaN, Infinity, -1]) {
    let thrown = false;
    try {
      buildSearchQuery('raport', { limit });
    } catch {
      thrown = true;
    }
    assertTrue(thrown, `limit ${String(limit)} should be rejected`);
  }
});

test('buildSearchQuery escapes double quotes in the filename filter', () => {
  const query = buildSearchQuery('he"llo');
  assertTrue(query.includes('he\\"llo'), query);
  assertFalse(query.includes('he"llo'), query);
});

test('buildSearchQuery escapes backslashes', () => {
  const query = buildSearchQuery('foo\\bar');
  assertTrue(query.includes('foo\\\\bar'), query);
});

test('a SPARQL injection with quote and brace stays inside the literal', () => {
  const injection = 'report"} UNION { ?file nie:url ?evil';
  const query = buildSearchQuery(injection);
  assertTrue(query.includes('\\"'), query);
  assertTrue(query.includes('report\\"} UNION'), query);
  assertFalse(query.includes('report"} UNION'), query);
  assertTrue(query.includes('FILTER('), query);
});

test('buildSearchQuery uses Tracker FTS and the file name variable', () => {
  const query = buildSearchQuery('EULA.en-US.txt', { contentSearch: true });
  assertTrue(query.includes('fts:match'), query);
  assertTrue(query.includes('nfo:fileName'), query);
  assertTrue(query.includes('nie:url'), query);
});

test('contentSearch off adds a filename filter, on allows content hits', () => {
  const filenameOnly = buildSearchQuery('raport', { contentSearch: false });
  const content = buildSearchQuery('raport', { contentSearch: true });
  assertTrue(filenameOnly.includes('CONTAINS(LCASE(?name)'), filenameOnly);
  assertFalse(content.includes('CONTAINS(LCASE(?name)'), content);
  assertTrue(content.includes('fts:match'), content);
});

test('an empty term builds a valid query that returns nothing', () => {
  const query = buildSearchQuery('   ', { limit: 3 });
  assertTrue(query.includes('FILTER(false)'), query);
  assertTrue(query.includes('LIMIT 3'), query);
});

test('mapRow decodes file URIs and normalizes metadata', () => {
  const row = mapRow({
    url: 'file:///home/anna/Dokumenty/raport%202024.pdf',
    name: 'raport 2024.pdf',
    mime: 'application/pdf',
    size: '1234',
    mtime: '2024-01-02T03:04:05Z',
    rank: '7',
  });

  assertEqual(row.path, '/home/anna/Dokumenty/raport 2024.pdf');
  assertEqual(row.name, 'raport 2024.pdf');
  assertEqual(row.mime, 'application/pdf');
  assertEqual(row.size, 1234);
  assertEqual(row.modified, '2024-01-02T03:04:05Z');
  assertEqual(row.score, 7);
});

test('mapRow tolerates missing fields', () => {
  const row = mapRow({});
  assertEqual(row.path, '');
  assertEqual(row.name, '');
  assertEqual(row.mime, '');
  assertEqual(row.size, null);
  assertEqual(row.modified, null);
  assertEqual(row.score, 0);
});

test('mapRow accepts array-like cursor rows and derives a missing name', () => {
  const row = mapRow([
    'file:///tmp/bez%20nazwy.txt',
    null,
    'text/plain',
    null,
    null,
    null,
  ]);
  assertEqual(row.path, '/tmp/bez nazwy.txt');
  assertEqual(row.name, 'bez nazwy.txt');
  assertEqual(row.mime, 'text/plain');
  assertEqual(row.size, null);
});

run('tracker-query.test.js');