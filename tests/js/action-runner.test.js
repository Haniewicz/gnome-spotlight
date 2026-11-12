import {
  test, run, assertDeepEqual, assertEqual, assertFalse, assertTrue,
} from './harness.js';
import {
  argvForCommand,
  argvForReveal,
  parseActions,
  runAction,
} from '../../lib/action-runner.js';

function captureErrors(fn) {
  const had = Object.prototype.hasOwnProperty.call(globalThis, 'logError');
  const previous = globalThis.logError;
  const errors = [];
  globalThis.logError = error => errors.push(error);
  try {
    fn();
  } finally {
    if (had)
      globalThis.logError = previous;
    else
      delete globalThis.logError;
  }
  return errors;
}

function clipboardDeps(onText) {
  return {
    St: {
      ClipboardType: { CLIPBOARD: 1 },
      Clipboard: {
        get_default: () => ({
          set_text: (type, text) => onText(type, text),
        }),
      },
    },
  };
}

test('parseActions returns an empty object for null and undefined', () => {
  assertDeepEqual(parseActions(null), {});
  assertDeepEqual(parseActions(undefined), {});
});

test('parseActions parses the daemon JSON string', () => {
  const parsed = parseActions({
    actions: JSON.stringify({
      primary: { id: 'launch', type: 'app', appId: 'x.desktop' },
      secondary: { id: 'copy', type: 'copy', text: '/tmp/x' },
      menu: [
        { id: 'launch', type: 'app', appId: 'x.desktop' },
      ],
    }),
  });

  assertEqual(parsed.primary.type, 'app');
  assertEqual(parsed.primary.appId, 'x.desktop');
  assertEqual(parsed.secondary.type, 'copy');
  assertEqual(parsed.menu.length, 1);
});

test('parseActions accepts an already parsed actions object', () => {
  const primary = { id: 'copy', type: 'copy', text: 'hello' };
  const parsed = parseActions({ actions: { primary } });
  assertEqual(parsed.primary, primary);
  assertEqual(parsed.secondary, null);
  assertDeepEqual(parsed.menu, []);
});

test('parseActions returns an empty object and logs broken JSON', () => {
  let errors = [];
  let parsed = null;
  errors = captureErrors(() => {
    parsed = parseActions({ actions: '{"primary":' });
  });
  assertDeepEqual(parsed, {});
  assertEqual(errors.length, 1);
  assertTrue(errors[0] instanceof Error);
});

test('parseActions drops invalid menu entries instead of throwing', () => {
  const parsed = parseActions({
    actions: {
      menu: [null, 'not-an-action', 42, { id: 'ok', type: 'copy', text: 'x' }],
    },
  });
  assertEqual(parsed.menu.length, 1);
  assertEqual(parsed.menu[0].id, 'ok');
});

test('argvForCommand uses bash -lc and keeps the command as one argument', () => {
  assertDeepEqual(
    argvForCommand('echo "a b" && true'),
    ['gnome-terminal', '--', 'bash', '-lc', 'echo "a b" && true']
  );
  assertDeepEqual(
    argvForCommand('echo hi', 'kgx'),
    ['kgx', '-e', 'bash', '-lc', 'echo hi']
  );
});

test('argvForReveal prefers nautilus --select and falls back to gio open', () => {
  assertDeepEqual(
    argvForReveal('/home/user/Projekty/a b.txt', true),
    ['nautilus', '--select', '/home/user/Projekty/a b.txt']
  );
  assertDeepEqual(
    argvForReveal('/home/user/Projekty/a b.txt', false),
    ['gio', 'open', '/home/user/Projekty']
  );
  assertDeepEqual(
    argvForReveal('relative.txt', false),
    ['gio', 'open', '.']
  );
});

test('app activates through Shell.AppSystem first', () => {
  const calls = [];
  const deps = {
    Shell: {
      AppSystem: {
        get_default: () => ({
          lookup_app: id => {
            calls.push(['lookup', id]);
            return { activate: () => calls.push(['activate']) };
          },
        }),
      },
    },
  };

  assertTrue(runAction({ type: 'app', appId: 'org.gnome.Settings' }, null, deps));
  assertDeepEqual(calls, [
    ['lookup', 'org.gnome.Settings'],
    ['activate'],
  ]);
});

test('app without appId falls back to desktopFile', () => {
  const calls = [];
  const deps = {
    Shell: {
      AppSystem: { get_default: () => ({ lookup_app: () => null }) },
    },
    Gio: {
      DesktopAppInfo: {
        new_from_filename: filename => {
          calls.push(['filename', filename]);
          return {
            launch: (uris, context) => calls.push(['launch', uris, context]),
          };
        },
      },
    },
  };

  assertTrue(runAction({
    type: 'app',
    desktopFile: '/usr/share/applications/x.desktop',
  }, null, deps));
  assertDeepEqual(calls, [
    ['filename', '/usr/share/applications/x.desktop'],
    ['launch', [], null],
  ]);
});

test('app without an app or desktop file fails without throwing', () => {
  let result = true;
  const errors = captureErrors(() => {
    result = runAction({ type: 'app' }, null, {});
  });
  assertFalse(result);
  assertEqual(errors.length, 1);
});

test('file opens a file:// URI through Gio.AppInfo', () => {
  const calls = [];
  const deps = {
    Gio: {
      AppInfo: {
        launch_default_for_uri: (uri, context) => calls.push([uri, context]),
      },
    },
  };

  assertTrue(runAction({ type: 'file', path: '/tmp/a b.txt' }, null, deps));
  assertDeepEqual(calls, [['file:///tmp/a b.txt', null]]);
});

test('reveal uses nautilus --select when nautilus is in PATH', () => {
  const calls = [];
  const deps = {
    GLib: { find_program_in_path: name => name === 'nautilus' ? '/usr/bin/nautilus' : null },
    spawn: argv => calls.push(argv),
  };

  assertTrue(runAction({ type: 'reveal', path: '/tmp/dir/file.txt' }, null, deps));
  assertDeepEqual(calls, [['nautilus', '--select', '/tmp/dir/file.txt']]);
});

test('reveal falls back to gio open on the parent directory', () => {
  const calls = [];
  const deps = {
    GLib: { find_program_in_path: () => null },
    spawn: argv => calls.push(argv),
  };

  assertTrue(runAction({ type: 'reveal', path: '/tmp/dir/file.txt' }, null, deps));
  assertDeepEqual(calls, [['gio', 'open', '/tmp/dir']]);
});

test('settings launches the appInfo from the result path', () => {
  const calls = [];
  const deps = {
    Gio: {
      DesktopAppInfo: {
        new_from_filename: filename => ({
          launch: (uris, context) => calls.push([filename, uris, context]),
        }),
      },
    },
  };

  assertTrue(runAction({
    type: 'settings',
    appId: 'gnome-network-panel.desktop',
  }, { path: '/usr/share/applications/gnome-network-panel.desktop' }, deps));
  assertDeepEqual(calls, [[
    '/usr/share/applications/gnome-network-panel.desktop', [], null,
  ]]);
});

test('copy writes text to the St clipboard', () => {
  const calls = [];
  const deps = clipboardDeps((type, text) => calls.push([type, text]));

  assertTrue(runAction({ type: 'copy', text: 'SMOKE-42' }, null, deps));
  assertDeepEqual(calls, [[1, 'SMOKE-42']]);
});

test('command spawns gnome-terminal with bash -lc', () => {
  const calls = [];
  const deps = { spawn: argv => calls.push(argv) };

  assertTrue(runAction({ type: 'command', command: 'ls -la' }, null, deps));
  assertDeepEqual(calls, [['gnome-terminal', '--', 'bash', '-lc', 'ls -la']]);
});

test('command uses kgx -e when only kgx is available', () => {
  const calls = [];
  const deps = {
    GLib: {
      find_program_in_path: name => name === 'kgx' ? '/usr/bin/kgx' : null,
    },
    spawn: argv => calls.push(argv),
  };

  assertTrue(runAction({ type: 'command', command: 'top' }, null, deps));
  assertDeepEqual(calls, [['kgx', '-e', 'bash', '-lc', 'top']]);
});

test('systemd calls Manager.<Verb>Unit(name, replace) over D-Bus', () => {
  const calls = [];
  class FakeVariant {
    constructor(type, value) {
      this.type = type;
      this.value = value;
    }
  }
  class FakeVariantType {
    constructor(type) {
      this.type = type;
    }
  }
  const session = {
    call(...args) {
      calls.push(args);
      const callback = args[args.length - 1];
      callback(session, { ok: true });
    },
    call_finish: () => ({ ok: true }),
  };
  const deps = {
    GLib: { Variant: FakeVariant, VariantType: FakeVariantType },
    Gio: { DBus: { session }, DBusCallFlags: { NONE: 0 } },
  };

  assertTrue(runAction({
    type: 'systemd',
    verb: 'restart',
    unit: 'app.service',
  }, null, deps));

  assertEqual(calls.length, 1);
  const [bus, path, iface, method, parameters] = calls[0];
  assertEqual(bus, 'org.freedesktop.systemd1');
  assertEqual(path, '/org/freedesktop/systemd1');
  assertEqual(iface, 'org.freedesktop.systemd1.Manager');
  assertEqual(method, 'RestartUnit');
  assertEqual(parameters.type, '(ss)');
  assertDeepEqual(parameters.value, ['app.service', 'replace']);
});

test('docker-stop uses the provider argv when present', () => {
  const calls = [];
  const deps = { spawn: argv => calls.push(argv) };

  assertTrue(runAction({
    type: 'docker-stop',
    command: 'docker stop abc123',
    argv: ['docker', 'stop', 'abc123'],
  }, null, deps));
  assertDeepEqual(calls, [['docker', 'stop', 'abc123']]);
});

test('docker-stop parses the command and falls back to the id', () => {
  const calls = [];
  const deps = { spawn: argv => calls.push(argv) };

  assertTrue(runAction({
    type: 'docker-stop',
    command: 'docker stop abc123',
  }, null, deps));
  assertTrue(runAction({
    type: 'docker-stop',
    id: 'def456',
  }, null, deps));
  assertDeepEqual(calls, [
    ['docker', 'stop', 'abc123'],
    ['docker', 'stop', 'def456'],
  ]);
});

test('remote delegates to daemonCall Activate with the result id', () => {
  const calls = [];
  const deps = {
    daemonCall: (method, id) => {
      calls.push([method, id]);
      return true;
    },
  };

  assertTrue(runAction(
    { type: 'remote', remoteId: 'provider-item' },
    { id: 'org.gnome.Provider:provider-item' },
    deps
  ));
  assertDeepEqual(calls, [['Activate', 'org.gnome.Provider:provider-item']]);
});

test('remote accepts an action id when the result has no id', () => {
  const calls = [];
  const deps = {
    daemonCall: (method, id) => {
      calls.push([method, id]);
      return true;
    },
  };

  assertTrue(runAction({ type: 'remote', id: 'provider-item' }, null, deps));
  assertDeepEqual(calls, [['Activate', 'provider-item']]);
});

test('unknown action types return false and log once', () => {
  let result = true;
  const errors = captureErrors(() => {
    result = runAction({ type: 'not-a-real-action' }, null, {});
  });
  assertFalse(result);
  assertEqual(errors.length, 1);
});

test('runAction falls back to result.activation when action is missing', () => {
  const calls = [];
  const deps = clipboardDeps((type, text) => calls.push([type, text]));

  assertTrue(runAction(null, {
    activation: { type: 'copy', text: 'from-activation' },
  }, deps));
  assertDeepEqual(calls, [[1, 'from-activation']]);
});

test('runAction never lets a broken dependency throw', () => {
  const deps = {
    St: {
      Clipboard: { get_default: () => { throw new Error('no clipboard'); } },
      ClipboardType: { CLIPBOARD: 1 },
    },
  };

  let result = true;
  const errors = captureErrors(() => {
    result = runAction({ type: 'copy', text: 'x' }, null, deps);
  });
  assertFalse(result);
  assertEqual(errors.length, 1);
});

run('action-runner.test.js');