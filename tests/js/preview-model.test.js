import {
  test, run, assertDeepEqual, assertEqual, assertTrue, assertFalse,
} from './harness.js';
import {
  classify, formatMeta, textSnippet,
} from '../../lib/preview-model.js';

test('classify detects common image extensions case-insensitively', () => {
  assertEqual(classify('/tmp/photo.png'), 'image');
  assertEqual(classify('/tmp/photo.JPG'), 'image');
  assertEqual(classify('/tmp/photo.webp'), 'image');
  assertEqual(classify('/tmp/photo.svg'), 'image');
});

test('classify detects PDF files', () => {
  assertEqual(classify('/tmp/report.pdf'), 'pdf');
  assertEqual(classify('/tmp/REPORT.PDF'), 'pdf');
});

test('classify detects text and source files', () => {
  assertEqual(classify('/tmp/notes.md'), 'text');
  assertEqual(classify('/tmp/data.json'), 'text');
  assertEqual(classify('/tmp/script.sh'), 'text');
  assertEqual(classify('/tmp/source.py'), 'text');
});

test('classify detects office documents', () => {
  assertEqual(classify('/tmp/report.docx'), 'office');
  assertEqual(classify('/tmp/sheet.xlsx'), 'office');
  assertEqual(classify('/tmp/slides.odp'), 'office');
  assertEqual(classify('/tmp/letter.rtf'), 'office');
});

test('classify defaults unknown files and archives to binary', () => {
  assertEqual(classify('/tmp/archive.zip'), 'binary');
  assertEqual(classify('/tmp/photo.raw'), 'binary');
  assertEqual(classify('/tmp/no-extension'), 'binary');
  assertEqual(classify('/tmp/archive.tar.gz'), 'binary');
});

test('classify understands MIME type values as well as paths', () => {
  assertEqual(classify('image/png'), 'image');
  assertEqual(classify('application/pdf'), 'pdf');
  assertEqual(classify('text/plain'), 'text');
  assertEqual(
    classify('application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
    'office'
  );
  assertEqual(classify('application/octet-stream'), 'binary');
});

test('classify handles empty and extension-less text basenames', () => {
  assertEqual(classify(''), 'binary');
  assertEqual(classify(null), 'binary');
  assertEqual(classify(undefined), 'binary');
  assertEqual(classify('/tmp/README'), 'text');
  assertEqual(classify('/tmp/Makefile'), 'text');
  assertEqual(classify('/home/user/.bashrc'), 'text');
});

test('formatMeta always returns the size, modified and path rows', () => {
  const rows = formatMeta({ size: 2048, path: '/tmp/example.txt' });
  assertEqual(rows.length, 3);
  assertEqual(rows[0][0], 'Rozmiar');
  assertEqual(rows[1][0], 'Zmodyfikowano');
  assertEqual(rows[2][0], 'Ścieżka');
  assertEqual(rows[0][1], '2 KB');
  assertEqual(rows[2][1], '/tmp/example.txt');
});

test('formatMeta formats fractional sizes through lib/format.js', () => {
  const rows = formatMeta({ size: 1536, path: '/tmp/a' });
  assertEqual(rows[0][1], '1,5 KB');
});

test('formatMeta renders a Date modification time', () => {
  const rows = formatMeta({
    size: 1024,
    mtime: new Date('2024-05-01T12:00:00Z'),
    path: '/tmp/a.txt',
  });
  assertTrue(rows[1][1].length > 0);
  assertTrue(rows[1][1] !== '—');
});

test('formatMeta accepts Gio.FileInfo-like getters', () => {
  const rows = formatMeta({
    get_size: () => 1024,
    get_modification_date_time: () => ({ to_unix: () => 1714564800 }),
    path: '/tmp/info.txt',
  });
  assertEqual(rows[0][1], '1 KB');
  assertTrue(rows[1][1].length > 0);
  assertEqual(rows[2][1], '/tmp/info.txt');
});

test('textSnippet returns the first lines and a truncated flag', () => {
  const result = textSnippet('one\ntwo\nthree\nfour', 2);
  assertEqual(result.text, 'one\ntwo');
  assertEqual(result.truncated, true);
});

test('textSnippet normalizes CRLF and bare CR line endings', () => {
  const result = textSnippet('one\r\ntwo\rthree\nfour', 10);
  assertEqual(result.text, 'one\ntwo\nthree\nfour');
  assertEqual(result.truncated, false);
});

test('textSnippet does not count a trailing newline as another line', () => {
  const result = textSnippet('one\ntwo\n', 2);
  assertEqual(result.text, 'one\ntwo');
  assertEqual(result.truncated, false);
});

test('textSnippet replaces invalid UTF-8 instead of throwing', () => {
  const result = textSnippet(new Uint8Array([0x61, 0xff, 0x62]), 10);
  assertTrue(result.text.startsWith('a'));
  assertTrue(result.text.includes('\uFFFD'));
  assertFalse(result.truncated);
});

test('textSnippet accepts strings, arrays and ArrayBuffer input', () => {
  assertEqual(textSnippet('a\nb', 10).text, 'a\nb');
  assertEqual(textSnippet([0x61, 0x0a, 0x62], 10).text, 'a\nb');
  const buffer = Uint8Array.from([0x61, 0x0a, 0x62]).buffer;
  assertEqual(textSnippet(buffer, 10).text, 'a\nb');
});

test('textSnippet handles a zero or negative line limit', () => {
  assertEqual(textSnippet('a\nb', 0).text, '');
  assertEqual(textSnippet('a\nb', 0).truncated, true);
  assertEqual(textSnippet('a\nb', -5).text, '');
  assertEqual(textSnippet('a\nb', -5).truncated, true);
});

test('textSnippet never throws on empty or unsupported input', () => {
  assertDeepEqual(textSnippet(null), { text: '', truncated: false });
  assertDeepEqual(textSnippet(undefined), { text: '', truncated: false });
  assertDeepEqual(textSnippet(''), { text: '', truncated: false });
  assertDeepEqual(textSnippet({}), { text: '', truncated: false });
});

run('preview-model.test.js');