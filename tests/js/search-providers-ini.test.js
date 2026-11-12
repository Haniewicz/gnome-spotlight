import {
  assert, assertDeepEqual, assertEqual, assertFalse, assertTrue,
} from './harness.js';
import { describe, run, test } from './harness.js';
import {
  DEFAULT_SEARCH_PROVIDER_VERSION,
  discoverProviders,
  parseSearchProviderIni,
} from '../../lib/search-providers-ini.js';

const FULL = `[Shell Search Provider]
DesktopId=org.gnome.Settings.desktop
BusName=org.gnome.Settings.SearchProvider
ObjectPath=/org/gnome/Settings/SearchProvider
Version=2
AutoStart=true
`;

describe('search-providers-ini', () => {
  test('parses a complete descriptor', () => {
    assertDeepEqual(parseSearchProviderIni(FULL), {
      desktopId: 'org.gnome.Settings.desktop',
      busName: 'org.gnome.Settings.SearchProvider',
      objectPath: '/org/gnome/Settings/SearchProvider',
      version: 2,
      autoStart: true,
    });
  });

  test('returns null without the [Shell Search Provider] section', () => {
    assertEqual(parseSearchProviderIni('BusName=org.gnome.Settings\n'), null);
    assertEqual(parseSearchProviderIni('[Other]\nBusName=org.gnome.Settings\nObjectPath=/x\n'), null);
  });

  test('returns null when BusName is missing', () => {
    const text = '[Shell Search Provider]\nObjectPath=/org/gnome/X\nVersion=2\n';
    assertEqual(parseSearchProviderIni(text), null);
  });

  test('returns null when ObjectPath is missing', () => {
    const text = '[Shell Search Provider]\nBusName=org.gnome.X\nVersion=2\n';
    assertEqual(parseSearchProviderIni(text), null);
  });

  test('unparsable Version falls back to 2', () => {
    const text = '[Shell Search Provider]\nBusName=org.gnome.X\nObjectPath=/x\nVersion=abc\n';
    assertEqual(parseSearchProviderIni(text).version, 2);
    assertEqual(DEFAULT_SEARCH_PROVIDER_VERSION, 2);
  });

  test('negative or fractional versions are normalised safely', () => {
    const base = '[Shell Search Provider]\nBusName=org.gnome.X\nObjectPath=/x\n';
    assertEqual(parseSearchProviderIni(`${base}Version=-3\n`).version, 2);
    assertEqual(parseSearchProviderIni(`${base}Version=2.9\n`).version, 2);
    assertEqual(parseSearchProviderIni(`${base}Version=3\n`).version, 3);
  });

  test('ignores # and ; comments and blank lines', () => {
    const text = `# leading comment
; another comment

[Shell Search Provider]
# BusName=ignored
BusName=org.gnome.Contacts.SearchProvider
ObjectPath=/org/gnome/Contacts/SearchProvider
Version=2

; trailing comment
DesktopId=org.gnome.Contacts.desktop
`;
    const parsed = parseSearchProviderIni(text);
    assertEqual(parsed.busName, 'org.gnome.Contacts.SearchProvider');
    assertEqual(parsed.desktopId, 'org.gnome.Contacts.desktop');
  });

  test('tolerates CRLF, BOM and surrounding whitespace', () => {
    const text = '\uFEFF  [Shell Search Provider]  \r\n' +
      '  BusName = org.gnome.Calculator.SearchProvider  \r\n' +
      '  ObjectPath = /org/gnome/Calculator/SearchProvider  \r\n' +
      '  Version = 2  \r\n';
    const parsed = parseSearchProviderIni(text);
    assertEqual(parsed.busName, 'org.gnome.Calculator.SearchProvider');
    assertEqual(parsed.objectPath, '/org/gnome/Calculator/SearchProvider');
    assertEqual(parsed.version, 2);
  });

  test('AutoStart defaults to false and accepts boolean spellings', () => {
    const base = '[Shell Search Provider]\nBusName=org.gnome.X\nObjectPath=/x\n';
    assertFalse(parseSearchProviderIni(base).autoStart);
    assertTrue(parseSearchProviderIni(`${base}AutoStart=yes\n`).autoStart);
    assertTrue(parseSearchProviderIni(`${base}AutoStart=1\n`).autoStart);
    assertFalse(parseSearchProviderIni(`${base}AutoStart=off\n`).autoStart);
    assertFalse(parseSearchProviderIni(`${base}AutoStart=maybe\n`).autoStart);
  });

  test('strips quotes and trailing inline comments', () => {
    const text = `[Shell Search Provider]
DesktopId="org.gnome.Nautilus.desktop"
BusName='org.gnome.Nautilus'
ObjectPath=/org/gnome/Nautilus/SearchProvider # comment
Version=2
`;
    const parsed = parseSearchProviderIni(text);
    assertEqual(parsed.desktopId, 'org.gnome.Nautilus.desktop');
    assertEqual(parsed.busName, 'org.gnome.Nautilus');
    assertEqual(parsed.objectPath, '/org/gnome/Nautilus/SearchProvider');
  });

  test('non-string input returns null', () => {
    assertEqual(parseSearchProviderIni(null), null);
    assertEqual(parseSearchProviderIni(undefined), null);
    assertEqual(parseSearchProviderIni({}), null);
  });

  test('discoverProviders keeps user paths first and deduplicates', () => {
    const paths = discoverProviders({
      userDir: ['/home/u/search-providers/a.ini', '/home/u/search-providers/b.ini'],
      systemDir: ['/usr/share/search-providers/c.ini', '/home/u/search-providers/a.ini'],
    });
    assertDeepEqual(paths, [
      '/home/u/search-providers/a.ini',
      '/home/u/search-providers/b.ini',
      '/usr/share/search-providers/c.ini',
    ]);
  });

  test('discoverProviders filters non-ini entries and empty values', () => {
    const paths = discoverProviders({
      userDir: ['/u/a.ini', '', '/u/README', null, '/u/b.INI'],
      systemDir: ['/s/c.ini'],
    });
    assertDeepEqual(paths, ['/u/a.ini', '/u/b.INI', '/s/c.ini']);
  });

  test('discoverProviders accepts a single string value', () => {
    assertDeepEqual(
      discoverProviders({ userDir: '/u/a.ini', systemDir: '/s/b.ini' }),
      ['/u/a.ini', '/s/b.ini']
    );
  });

  test('discoverProviders joins directory/file pairs and objects', () => {
    assertDeepEqual(
      discoverProviders({
        userDir: [['/u', 'a.ini', 'b.ini']],
        systemDir: [{ dir: '/s', files: ['c.ini'] }],
      }),
      ['/u/a.ini', '/u/b.ini', '/s/c.ini']
    );
  });

  test('discoverProviders returns an empty list for missing input', () => {
    assertDeepEqual(discoverProviders(), []);
    assertDeepEqual(discoverProviders({}), []);
  });
});

run('search-providers-ini');