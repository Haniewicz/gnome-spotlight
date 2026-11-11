import {
  test, run, assert, assertEqual, assertTrue,
} from './harness.js';
import { shortenPath, humanSize, formatNumber } from '../../lib/format.js';

test('a path inside HOME starts with "~"', () => {
  assertEqual(shortenPath('/home/anna', '/home/anna', 80), '~');
  assertEqual(shortenPath('/home/anna/Dokumenty/raport.txt', '/home/anna', 80), '~/Dokumenty/raport.txt');
});

test('a sibling of HOME is not rewritten', () => {
  assertEqual(shortenPath('/home/annafile', '/home/anna', 80), '/home/annafile');
});

test('long paths are shortened in the middle', () => {
  const path = '/home/anna/Dokumenty/bardzo/dlugie/sciezki/roczny-raport-2024.pdf';
  const shortened = shortenPath(path, '/home/anna', 24);

  assertTrue(shortened.length <= 24, `expected <= 24 characters, got ${shortened.length}`);
  // `~/` + ellipsis + 22-char basename needs 25 chars, so with maxLen 24 the home marker
  // can only be the bare `~`. The home hint must survive; the trailing slash cannot.
  assertTrue(shortened.startsWith('~'), `expected a ~ prefix, got ${shortened}`);
  assertTrue(shortened.includes('…'), `expected a middle ellipsis, got ${shortened}`);
  assertTrue(shortened.endsWith('raport-2024.pdf'), `basename was lost: ${shortened}`);
});

test('keeps the "~/" prefix when the budget allows it', () => {
  const path = '/home/anna/Dokumenty/bardzo/dlugie/sciezki/roczny-raport-2024.pdf';
  const shortened = shortenPath(path, '/home/anna', 27);

  assertTrue(shortened.length <= 27, `expected <= 27 characters, got ${shortened.length}`);
  assertEqual(shortened, '~/…roczny-raport-2024.pdf');
});

test('short paths are left untouched and maxLen edge cases are safe', () => {
  assertEqual(shortenPath('/tmp/a.txt', '/home/anna', 80), '/tmp/a.txt');
  assertEqual(shortenPath('/home/anna/a.txt', '/home/anna', 1), '…');
  assertEqual(shortenPath('/home/anna/a.txt', '/home/anna', 0), '');
});

test('humanSize handles zero and byte-sized values', () => {
  assertEqual(humanSize(0), '0 B');
  assertEqual(humanSize(1), '1 B');
  assertEqual(humanSize(512), '512 B');
});

test('humanSize handles KB, MB and GB', () => {
  assertEqual(humanSize(1024), '1 KB');
  assertEqual(humanSize(1536), '1,5 KB');
  assertEqual(humanSize(1024 * 1024), '1 MB');
  assertEqual(humanSize(1024 * 1024 * 1024), '1 GB');
});

test('formatNumber uses Polish grouping and decimal comma', () => {
  assertEqual(formatNumber(1234.56), '1 234,56');
  assertEqual(formatNumber(0), '0');
  assertEqual(formatNumber(-1234.5), '-1 234,5');
});

test('formatNumber is defensive about invalid input', () => {
  assertEqual(formatNumber(NaN), '');
  assertEqual(formatNumber(Infinity), '');
});

run('format.test.js');