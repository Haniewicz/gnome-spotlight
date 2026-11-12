import {
  test, run, assertDeepEqual, assertEqual,
} from './harness.js';
import { parseSnippets } from '../../lib/snippets.js';

test('a valid array is normalized to keyword/name/text', () => {
  const json = JSON.stringify([
    { keyword: 'sig', name: 'Podpis', text: 'Jan Kowalski' },
    { keyword: 'mail', name: 'E-mail', text: 'jan@example.com' },
  ]);

  assertDeepEqual(parseSnippets(json), [
    { keyword: 'sig', name: 'Podpis', text: 'Jan Kowalski' },
    { keyword: 'mail', name: 'E-mail', text: 'jan@example.com' },
  ]);
});

test('broken JSON degrades to an empty list', () => {
  assertDeepEqual(parseSnippets('{not json'), []);
  assertDeepEqual(parseSnippets(''), []);
});

test('non-array roots and non-object entries are ignored', () => {
  assertDeepEqual(parseSnippets('null'), []);
  assertDeepEqual(parseSnippets('42'), []);
  assertDeepEqual(parseSnippets(JSON.stringify(['sig', 7, null])), []);
});

test('entries without text or with empty text are rejected', () => {
  const json = JSON.stringify([
    { keyword: 'missing' },
    { keyword: 'empty', text: '' },
    { keyword: 'blank', text: '   ' },
    { keyword: 'ok', text: 'Treść' },
  ]);

  assertDeepEqual(parseSnippets(json), [
    { keyword: 'ok', name: 'ok', text: 'Treść' },
  ]);
});

test('blank keywords and keywords containing whitespace are rejected', () => {
  const json = JSON.stringify([
    { keyword: '', text: 'a' },
    { keyword: '   ', text: 'b' },
    { keyword: 'two words', text: 'c' },
    { keyword: 'valid', text: 'd' },
  ]);

  assertDeepEqual(parseSnippets(json), [
    { keyword: 'valid', name: 'valid', text: 'd' },
  ]);
});

test('name falls back to keyword and duplicate keywords keep the first entry', () => {
  const json = JSON.stringify([
    { keyword: 'sig', text: 'pierwszy' },
    { keyword: 'sig', name: 'Drugi', text: 'drugi' },
  ]);

  assertDeepEqual(parseSnippets(json), [
    { keyword: 'sig', name: 'sig', text: 'pierwszy' },
  ]);
});

test('a snippets wrapper and the keyword map form are accepted', () => {
  assertDeepEqual(
    parseSnippets(JSON.stringify({
      snippets: [{ keyword: 'wrapped', name: 'W', text: 'treść' }],
    })),
    [{ keyword: 'wrapped', name: 'W', text: 'treść' }]
  );

  assertDeepEqual(
    parseSnippets(JSON.stringify({
      addr: { name: 'Adres', text: 'ul. Testowa 1' },
      plain: 'zwykły tekst',
    })),
    [
      { keyword: 'addr', name: 'Adres', text: 'ul. Testowa 1' },
      { keyword: 'plain', name: 'plain', text: 'zwykły tekst' },
    ]
  );
});

test('already parsed input is accepted without re-serialization', () => {
  assertEqual(parseSnippets([{ keyword: 'x', text: 'y' }]).length, 1);
});

run('snippets.test.js');
