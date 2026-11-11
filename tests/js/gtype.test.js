import {
  test, run, assert, assertEqual, assertNotEqual, assertTrue,
} from './harness.js';
import { gtypeName, gtypeToken } from '../../lib/gtype.js';

const PRIMARY_URI =
  'file:///home/user/.local/share/gnome-shell/extensions/' +
  'spotlight@haniewicz.dev/lib/ui/modal.js';
const SECONDARY_URI =
  'file:///home/user/.local/share/gnome-shell/extensions/' +
  'spotlight@haniewicz.dev-v2/lib/ui/modal.js';

function withExtension(extension, fn) {
  const hadExtension = Object.prototype.hasOwnProperty.call(globalThis, 'Extension');
  const previous = globalThis.Extension;
  try {
    globalThis.Extension = extension;
    fn();
  } finally {
    if (hadExtension)
      globalThis.Extension = previous;
    else
      delete globalThis.Extension;
  }
}

test('two different extension URIs produce different GType names', () => {
  assertNotEqual(gtypeToken(PRIMARY_URI), gtypeToken(SECONDARY_URI));
  assertNotEqual(
    gtypeName('Modal', PRIMARY_URI),
    gtypeName('Modal', SECONDARY_URI)
  );
});

test('the same URI always produces the same GType name', () => {
  assertEqual(gtypeToken(PRIMARY_URI), gtypeToken(PRIMARY_URI));
  assertEqual(gtypeName('ResultRow', PRIMARY_URI), gtypeName('ResultRow', PRIMARY_URI));
});

test('names are alphanumeric and contain no UUID punctuation', () => {
  const name = gtypeName('PreviewPanel', SECONDARY_URI);
  const token = gtypeToken(SECONDARY_URI);

  assert(/^Spotlight[A-Za-z0-9]+$/.test(name), `invalid GType name: ${name}`);
  assert(/^[A-Za-z0-9]+$/.test(token), `invalid token: ${token}`);
  assert(!name.includes('@'), 'name contains @ from the UUID');
  assert(!name.includes('.'), 'name contains . from the UUID');
  assert(!name.includes('-'), 'name contains - from the UUID');
});

test('a missing Extension object falls back without throwing', () => {
  withExtension(undefined, () => {
    assertEqual(gtypeToken(''), 'default');
    assertEqual(gtypeToken(null), 'default');
    assertEqual(gtypeName('Modal', ''), 'SpotlightModaldefault');
  });
});

test('tokens are at most 24 characters and names at most 64', () => {
  const longURI =
    'file:///tmp/extensions/spotlight@' + 'a'.repeat(80) + '.dev/lib/ui/modal.js';
  const token = gtypeToken(longURI);
  const name = gtypeName('PreviewPanel', longURI);

  assertTrue(token.length > 0 && token.length <= 24, `token length ${token.length}`);
  assertTrue(name.length <= 64, `name length ${name.length}`);
  assertEqual(name, `SpotlightPreviewPanel${token}`);
});

test('Extension.lookupByURL wins over the path-derived UUID', () => {
  withExtension({
    lookupByURL(uri) {
      assertEqual(uri, 'file:///tmp/not-a-uuid/lib/gtype.js');
      return { uuid: 'spotlight@haniewicz.dev-v2' };
    },
  }, () => {
    assertEqual(
      gtypeToken('file:///tmp/not-a-uuid/lib/gtype.js'),
      'spotlighthaniewiczdevv2'
    );
  });
});

test('a failing Extension lookup falls back to the URI directory', () => {
  withExtension({
    lookupByURL() {
      throw new Error('not a registered extension');
    },
  }, () => {
    assertEqual(
      gtypeToken(
        'file:///tmp/spotlight%40haniewicz.dev/lib/ui/modal.js'
      ),
      'spotlighthaniewiczdev'
    );
  });
});

run('gtype.test.js');