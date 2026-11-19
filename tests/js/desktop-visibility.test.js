import {
  test, run, assertTrue, assertFalse, assertDeepEqual,
} from './harness.js';
import {
  desktopList,
  shouldShowOnDesktops,
  FALLBACK_DESKTOPS,
} from '../../lib/desktop-visibility.js';

test('desktopList splits XDG_CURRENT_DESKTOP on colons', () => {
  assertDeepEqual(desktopList('GNOME:GNOME-Classic'), ['gnome', 'gnome-classic']);
  assertDeepEqual(desktopList(' ubuntu '), ['ubuntu']);
});

test('desktopList falls back to GNOME for empty or missing values', () => {
  assertDeepEqual(desktopList(''), [...FALLBACK_DESKTOPS]);
  assertDeepEqual(desktopList(undefined), ['gnome']);
  assertDeepEqual(desktopList('::'), ['gnome']);
  assertDeepEqual(desktopList('', ['kde']), ['kde']);
});

test('OnlyShowIn allows only the listed desktops', () => {
  assertTrue(shouldShowOnDesktops({
    onlyShowIn: 'GNOME;',
    desktops: ['gnome'],
  }));
  assertFalse(shouldShowOnDesktops({
    onlyShowIn: 'KDE;',
    desktops: ['gnome'],
  }));
});

test('NotShowIn hides the listed desktops', () => {
  assertFalse(shouldShowOnDesktops({
    notShowIn: 'GNOME;Unity;',
    desktops: ['gnome'],
  }));
  assertTrue(shouldShowOnDesktops({
    notShowIn: 'KDE;',
    desktops: ['gnome'],
  }));
});

test('missing desktop lists never hide the app', () => {
  assertTrue(shouldShowOnDesktops({ desktops: ['gnome'] }));
  assertTrue(shouldShowOnDesktops({ onlyShowIn: '', notShowIn: ';' }));
});

test('GNOME-only apps stay visible when the env is missing', () => {
  // This is the daemon case: no XDG_CURRENT_DESKTOP must not hide GNOME apps.
  const desktops = desktopList(undefined);
  assertTrue(shouldShowOnDesktops({ onlyShowIn: 'GNOME;', desktops }));
});

test('entries with Desktop Action groups do not confuse the list', () => {
  // Guard the semicolon parser against double/trailing separators.
  assertTrue(shouldShowOnDesktops({
    onlyShowIn: ';;GNOME;;GNOME-Classic;',
    desktops: ['gnome-classic'],
  }));
  assertFalse(shouldShowOnDesktops({
    onlyShowIn: ';;KDE;;',
    desktops: ['gnome'],
  }));
});

run('desktop-visibility.test.js');
