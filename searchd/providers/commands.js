// Daemon-side command palette provider.
//
// Plain ">" commands are only described; the extension client launches them in
// a terminal. The specialised modes (ssh/sys/snip/docker) enumerate hosts,
// user units, snippets and containers. D-Bus calls and subprocesses are always
// asynchronous: nothing here may block the daemon's main loop or interpolate a
// query into a shell command.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import { rankResults, scoreResult } from '../../lib/ranking.js';
import { ProviderPriority } from '../../lib/providers/registry.js';
import { parseSshConfig } from '../../lib/ssh-config.js';
import { parseSnippets } from '../../lib/snippets.js';
import { formatUnitAction, rankUnits } from '../../lib/systemd-units.js';

const PROVIDER_ID = 'commands';
const TERMINAL_MISSING_DESCRIPTION =
  'Polecenie zostanie uruchomione w terminalu przez klienta rozszerzenia.';
const LIMIT = 8;

const SSH_CACHE_TTL_MS = 60 * 1000;
const SNIPPETS_CACHE_TTL_MS = 5 * 1000;
const SYSTEMD_CACHE_TTL_MS = 10 * 1000;
const DOCKER_CACHE_TTL_MS = 5 * 1000;
const SYSTEMD_TIMEOUT_MS = 220;
const DOCKER_TIMEOUT_MS = 300;

const SYSTEMD_BUS_NAME = 'org.freedesktop.systemd1';
const SYSTEMD_OBJECT_PATH = '/org/freedesktop/systemd1';
const SYSTEMD_INTERFACE = 'org.freedesktop.systemd1.Manager';
const SYSTEMD_VERBS = Object.freeze({
  start: 'StartUnit',
  stop: 'StopUnit',
  restart: 'RestartUnit',
});

const MODES = new Set(['ssh', 'sys', 'snip', 'docker']);

function modeName(value) {
  const mode = String(value ?? '').trim().toLowerCase();
  return MODES.has(mode) ? mode : '';
}

function detectMode(query, contextMode = '') {
  const explicit = String(contextMode ?? '').trim().toLowerCase();
  if (MODES.has(explicit))
    return explicit;
  if (explicit === 'commands')
    return 'commands';

  const text = String(query ?? '').trim().toLowerCase();
  for (const mode of MODES) {
    if (text === mode || text.startsWith(`${mode} `))
      return mode;
  }
  return '';
}

function stripPrefix(query, mode) {
  let text = String(query ?? '').trim();
  if (text.startsWith('>'))
    text = text.slice(1).trimStart();

  const prefix = `${mode} `;
  if (text.toLowerCase().startsWith(prefix))
    text = text.slice(prefix.length).trimStart();
  else if (text.toLowerCase() === mode)
    text = '';
  return text;
}

function decode(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  } catch {
    return '';
  }
}

function readTextFile(path) {
  try {
    const [ok, contents] = GLib.file_get_contents(String(path));
    if (!ok)
      return '';
    return decode(contents);
  } catch {
    return '';
  }
}

function asResult(id, title, subtitle, kind, icon) {
  return {
    id,
    providerId: PROVIDER_ID,
    title,
    subtitle,
    kind,
    icon,
    key: title,
  };
}

function findTerminal() {
  try {
    if (GLib.find_program_in_path('gnome-terminal'))
      return 'gnome-terminal';
    if (GLib.find_program_in_path('kgx'))
      return 'kgx';
  } catch {
    // A restricted PATH simply means no terminal was discovered.
  }
  return '';
}

function terminalArgv(program, argv) {
  if (program === 'kgx')
    return ['kgx', '-e', ...argv];
  if (program === 'gnome-terminal')
    return ['gnome-terminal', '--', ...argv];
  return argv.slice();
}

function runProcess(argv, timeoutMs) {
  return new Promise(resolve => {
    let process;
    try {
      process = Gio.Subprocess.new(
        argv,
        Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
      );
    } catch {
      resolve({ ok: false, stdout: '', timedOut: false });
      return;
    }

    let settled = false;
    let timer = 0;

    const finish = value => {
      if (settled)
        return;
      settled = true;
      if (timer) {
        try {
          GLib.source_remove(timer);
        } catch {
          // The timeout source already fired.
        }
        timer = 0;
      }
      resolve(value);
    };

    timer = GLib.timeout_add(
      GLib.PRIORITY_DEFAULT,
      Math.max(1, Math.floor(timeoutMs)),
      () => {
        timer = 0;
        try {
          process.force_exit();
        } catch {
          // The process may have exited between the timeout and this call.
        }
        finish({ ok: false, stdout: '', timedOut: true });
        return GLib.SOURCE_REMOVE;
      }
    );

    try {
      process.communicate_utf8_async(null, null, (source, result) => {
        let stdout = '';
        let ok = false;
        try {
          const [, output] = source.communicate_utf8_finish(result);
          stdout = output ?? '';
          ok = source.get_successful();
        } catch {
          stdout = '';
          ok = false;
        }
        finish({ ok, stdout, timedOut: false });
      });
    } catch {
      try {
        process.force_exit();
      } catch {
        // Already gone.
      }
      finish({ ok: false, stdout: '', timedOut: false });
    }
  });
}

function callDbus(
  connection,
  busName,
  objectPath,
  interfaceName,
  methodName,
  parameters,
  replyType,
  timeoutMs
) {
  return new Promise(resolve => {
    if (!connection || typeof connection.call !== 'function') {
      resolve(null);
      return;
    }

    let settled = false;
    let timer = 0;
    let cancellable = null;

    const finish = value => {
      if (settled)
        return;
      settled = true;
      if (timer) {
        try {
          GLib.source_remove(timer);
        } catch {
          // The timeout source already fired.
        }
        timer = 0;
      }
      resolve(value);
    };

    try {
      cancellable = new Gio.Cancellable();
    } catch {
      resolve(null);
      return;
    }

    timer = GLib.timeout_add(
      GLib.PRIORITY_DEFAULT,
      Math.max(1, Math.floor(timeoutMs)),
      () => {
        timer = 0;
        try {
          cancellable.cancel();
        } catch {
          // Cancellation is best effort.
        }
        finish(null);
        return GLib.SOURCE_REMOVE;
      }
    );

    try {
      connection.call(
        busName,
        objectPath,
        interfaceName,
        methodName,
        parameters,
        replyType,
        Gio.DBusCallFlags.NONE,
        Math.max(1, Math.floor(timeoutMs)),
        cancellable,
        (source, result) => {
          let value = null;
          try {
            const reply = source.call_finish(result);
            value = typeof reply?.deep_unpack === 'function'
              ? reply.deep_unpack()
              : reply;
          } catch {
            value = null;
          }
          finish(value);
        }
      );
    } catch {
      finish(null);
    }
  });
}

function unitFromEntry(entry) {
  if (Array.isArray(entry)) {
    return {
      Name: String(entry[0] ?? ''),
      Description: String(entry[1] ?? ''),
      LoadState: String(entry[2] ?? ''),
      ActiveState: String(entry[3] ?? ''),
      SubState: String(entry[4] ?? ''),
      Following: String(entry[5] ?? ''),
      UnitPath: String(entry[6] ?? ''),
      JobId: Number(entry[7] ?? 0),
      JobType: String(entry[8] ?? ''),
      JobPath: String(entry[9] ?? ''),
    };
  }

  if (!entry || typeof entry !== 'object')
    return null;

  return {
    Name: String(entry.Name ?? entry.name ?? ''),
    Description: String(entry.Description ?? entry.description ?? ''),
    LoadState: String(entry.LoadState ?? entry.loadState ?? ''),
    ActiveState: String(entry.ActiveState ?? entry.activeState ?? ''),
    SubState: String(entry.SubState ?? entry.subState ?? ''),
    Following: String(entry.Following ?? entry.following ?? ''),
    UnitPath: String(entry.UnitPath ?? entry.unitPath ?? ''),
    JobId: Number(entry.JobId ?? entry.jobId ?? 0),
    JobType: String(entry.JobType ?? entry.jobType ?? ''),
    JobPath: String(entry.JobPath ?? entry.jobPath ?? ''),
  };
}

function parseUnitList(reply) {
  if (!Array.isArray(reply))
    return [];

  const raw = reply.length === 1 && Array.isArray(reply[0])
    ? reply[0]
    : reply;
  if (!Array.isArray(raw))
    return [];

  const units = [];
  for (const item of raw) {
    const unit = unitFromEntry(item);
    if (!unit || unit.Name === '')
      continue;
    if (unit.LoadState !== '' &&
        unit.LoadState.toLowerCase() !== 'loaded')
      continue;
    units.push(unit);
  }
  return units;
}

function parseContainerList(stdout) {
  const containers = [];
  for (const line of String(stdout ?? '').split(/\r?\n/)) {
    if (line.trim() === '')
      continue;
    const fields = line.split('\t');
    const id = String(fields[0] ?? '').trim();
    if (id === '')
      continue;
    containers.push({
      id,
      name: String(fields[1] ?? '').trim() || id,
      image: String(fields[2] ?? '').trim(),
      status: String(fields[3] ?? '').trim(),
    });
  }
  return containers;
}

function hostResult(host, terminal) {
  const userPrefix = host.user === '' ? '' : `${host.user}@`;
  const endpoint = `${userPrefix}${host.hostName}:${host.port}`;
  const sshArgv = ['ssh', host.alias];
  const launcher = terminalArgv(terminal, sshArgv);

  const result = asResult(
    `ssh:${host.alias}`,
    host.alias,
    endpoint,
    'Host SSH',
    'network-server-symbolic'
  );
  result.key = host.alias;
  result.activation = { type: 'command', command: sshArgv.join(' ') };
  result.actions = {
    primary: {
      id: 'ssh-terminal',
      label: 'Połącz przez SSH',
      type: 'command',
      command: sshArgv.join(' '),
      argv: launcher,
    },
    secondary: {
      id: 'copy-ssh',
      label: 'Kopiuj adres SSH',
      type: 'copy',
      text: sshArgv.join(' '),
    },
    menu: [
      {
        id: 'ssh-terminal',
        label: 'Połącz przez SSH',
        type: 'command',
        command: sshArgv.join(' '),
        argv: launcher,
      },
      {
        id: 'copy-ssh',
        label: 'Kopiuj adres SSH',
        type: 'copy',
        text: sshArgv.join(' '),
      },
    ],
  };
  result.preview = {
    rows: [
      ['Host', host.alias],
      ['Adres', endpoint],
      ['Terminal', terminal || 'ssh'],
    ],
    description: `Połączenie SSH z ${endpoint}`,
  };
  return result;
}

function unitActions(unit) {
  const menu = [];
  for (const verb of ['start', 'stop', 'restart', 'status']) {
    const action = formatUnitAction(unit, verb);
    if (!action)
      continue;
    const entry = {
      id: `systemd-${verb}`,
      label: action.label,
      type: 'systemd',
      // `command`/`path` survive the generic action serializer as the verb
      // and unit name, so a D-Bus client can call Manager.<Verb>Unit without
      // ever building a shell command.
      command: verb,
      path: String(unit.Name ?? ''),
      verb,
      unit: String(unit.Name ?? ''),
      argv: action.argv,
      busName: SYSTEMD_BUS_NAME,
      objectPath: SYSTEMD_OBJECT_PATH,
      interface: SYSTEMD_INTERFACE,
      method: SYSTEMD_VERBS[verb] ?? '',
    };
    menu.push(entry);
  }

  return {
    primary: menu[0] ?? null,
    secondary: menu[1] ?? null,
    menu,
  };
}

function unitResult(unit) {
  const result = asResult(
    `sys:${unit.Name}`,
    unit.Name,
    unit.Description || [unit.ActiveState, unit.SubState]
      .filter(Boolean)
      .join(' / '),
    'Usługa',
    'system-run-symbolic'
  );
  result.key = unit.Name;
  result.activation = {
    type: 'systemd',
    verb: 'start',
    unit: unit.Name,
  };
  result.actions = unitActions(unit);
  result.preview = {
    rows: [
      ['Jednostka', unit.Name],
      ['Opis', unit.Description || '—'],
      ['Stan', [unit.LoadState, unit.ActiveState, unit.SubState]
        .filter(Boolean)
        .join(' / ')],
    ],
    description: unit.Description || unit.Name,
  };
  return result;
}

function snippetResult(snippet) {
  const previewText = snippet.text.length > 120
    ? `${snippet.text.slice(0, 117)}…`
    : snippet.text;
  const result = asResult(
    `snip:${snippet.keyword}`,
    snippet.name,
    `${snippet.keyword} · ${previewText}`,
    'Snippet',
    'text-x-generic-symbolic'
  );
  result.key = snippet.keyword;
  result.activation = { type: 'copy', text: snippet.text };
  result.actions = {
    primary: {
      id: 'copy-snippet',
      label: 'Wstaw do schowka',
      type: 'copy',
      text: snippet.text,
    },
    menu: [
      {
        id: 'copy-snippet',
        label: 'Wstaw do schowka',
        type: 'copy',
        text: snippet.text,
      },
    ],
  };
  result.preview = {
    rows: [
      ['Słowo kluczowe', snippet.keyword],
      ['Nazwa', snippet.name],
      ['Treść', previewText],
    ],
    description: 'Snippet zostanie skopiowany do schowka.',
  };
  return result;
}

function containerResult(container, binary, terminal) {
  const logArgv = [binary, 'logs', '--tail', '200', container.id];
  const stopArgv = [binary, 'stop', container.id];
  const result = asResult(
    `docker:${container.id}`,
    container.name,
    [container.image, container.status].filter(Boolean).join(' · '),
    'Kontener',
    'application-x-executable-symbolic'
  );
  result.key = container.id;
  result.activation = { type: 'command', command: logArgv.join(' ') };
  result.actions = {
    primary: {
      id: 'docker-logs',
      label: 'Otwórz logi',
      type: 'command',
      command: logArgv.join(' '),
      argv: terminalArgv(terminal, logArgv),
    },
    secondary: {
      id: 'docker-stop',
      label: 'Zatrzymaj kontener',
      type: 'docker-stop',
      command: stopArgv.join(' '),
      argv: stopArgv,
    },
    menu: [
      {
        id: 'docker-logs',
        label: 'Otwórz logi',
        type: 'command',
        command: logArgv.join(' '),
        argv: terminalArgv(terminal, logArgv),
      },
      {
        id: 'docker-stop',
        label: 'Zatrzymaj kontener',
        type: 'docker-stop',
        command: stopArgv.join(' '),
        argv: stopArgv,
      },
    ],
  };
  result.preview = {
    rows: [
      ['Kontener', container.name],
      ['ID', container.id],
      ['Obraz', container.image || '—'],
      ['Stan', container.status || '—'],
    ],
    description: `${binary} logs --tail 200 ${container.id}`,
  };
  return result;
}

export function createProvider(options = {}) {
  const settings = options && typeof options === 'object' ? options : {};
  const now = typeof settings.now === 'function' ? settings.now : Date.now;
  const sshPath = typeof settings.sshConfigPath === 'string'
    ? settings.sshConfigPath
    : GLib.build_filenamev([GLib.get_home_dir(), '.ssh', 'config']);
  const snippetsPath = typeof settings.snippetsPath === 'string'
    ? settings.snippetsPath
    : GLib.build_filenamev([
        GLib.get_user_config_dir(),
        'gnome-spotlight',
        'snippets.json',
      ]);

  let connection = settings.connection ?? null;
  if (connection === null) {
    try {
      connection = Gio.DBus.session;
    } catch {
      connection = null;
    }
  }

  let sshCache = { at: 0, path: '', hosts: [] };
  let snippetsCache = { at: 0, path: '', snippets: [] };
  let systemdCache = { at: 0, units: [] };
  let systemdFetch = null;
  let dockerCache = { at: 0, binary: '', containers: [] };
  let dockerFetch = null;

  function sshHosts() {
    const timestamp = now();
    if (sshCache.path === sshPath &&
        timestamp - sshCache.at < SSH_CACHE_TTL_MS) {
      return sshCache.hosts;
    }

    const hosts = parseSshConfig(readTextFile(sshPath));
    sshCache = { at: timestamp, path: sshPath, hosts };
    return hosts;
  }

  function snippets() {
    const timestamp = now();
    if (snippetsCache.path === snippetsPath &&
        timestamp - snippetsCache.at < SNIPPETS_CACHE_TTL_MS) {
      return snippetsCache.snippets;
    }

    const list = parseSnippets(readTextFile(snippetsPath));
    snippetsCache = { at: timestamp, path: snippetsPath, snippets: list };
    return list;
  }

  async function fetchUnits() {
    if (systemdFetch)
      return systemdFetch;

    systemdFetch = callDbus(
      connection,
      SYSTEMD_BUS_NAME,
      SYSTEMD_OBJECT_PATH,
      SYSTEMD_INTERFACE,
      'ListUnits',
      null,
      new GLib.VariantType('(a(ssssssouso))'),
      SYSTEMD_TIMEOUT_MS
    ).then(reply => {
      const units = parseUnitList(reply);
      systemdCache = { at: now(), units };
      return units;
    }).catch(() => {
      systemdCache = { at: now(), units: [] };
      return [];
    }).finally(() => {
      systemdFetch = null;
    });

    return systemdFetch;
  }

  function units() {
    if (now() - systemdCache.at < SYSTEMD_CACHE_TTL_MS)
      return Promise.resolve(systemdCache.units);
    return fetchUnits();
  }

  function dockerBinary() {
    try {
      if (GLib.find_program_in_path('docker'))
        return 'docker';
      if (GLib.find_program_in_path('podman'))
        return 'podman';
    } catch {
      // Fall through to the empty list.
    }
    return '';
  }

  async function fetchContainers() {
    if (dockerFetch)
      return dockerFetch;

    const binary = dockerBinary();
    if (binary === '') {
      dockerCache = { at: now(), binary, containers: [] };
      return Promise.resolve([]);
    }

    dockerFetch = runProcess([
      binary,
      'ps',
      '--format',
      '{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Status}}',
    ], DOCKER_TIMEOUT_MS).then(result => {
      const containers = result.ok ? parseContainerList(result.stdout) : [];
      dockerCache = { at: now(), binary, containers };
      return containers;
    }).catch(() => {
      dockerCache = { at: now(), binary, containers: [] };
      return [];
    }).finally(() => {
      dockerFetch = null;
    });

    return dockerFetch;
  }

  function containers() {
    const binary = dockerBinary();
    if (dockerCache.binary === binary &&
        now() - dockerCache.at < DOCKER_CACHE_TTL_MS) {
      return Promise.resolve(dockerCache.containers);
    }
    return fetchContainers();
  }

  function commandResult(command) {
    return {
      id: `command:${command}`,
      providerId: PROVIDER_ID,
      title: `Uruchom: ${command}`,
      subtitle: TERMINAL_MISSING_DESCRIPTION,
      kind: 'Komenda',
      icon: 'utilities-terminal-symbolic',
      key: command,
      path: '',
      activation: { type: 'command', command },
      actions: {
        primary: {
          id: 'run-terminal',
          label: 'Uruchom w terminalu',
          type: 'command',
          command,
        },
        secondary: {
          id: 'copy-command',
          label: 'Kopiuj polecenie',
          type: 'copy',
          text: command,
        },
        menu: [
          {
            id: 'run-terminal',
            label: 'Uruchom w terminalu',
            type: 'command',
            command,
          },
          {
            id: 'copy-command',
            label: 'Kopiuj polecenie',
            type: 'copy',
            text: command,
          },
        ],
      },
      preview: {
        rows: [
          ['Polecenie', command],
          ['Wykonanie', 'klient rozszerzenia (terminal)'],
        ],
        description: TERMINAL_MISSING_DESCRIPTION,
      },
    };
  }

  async function searchHosts(needle) {
    const hosts = sshHosts();
    const filtered = needle === ''
      ? hosts
      : hosts.filter(host => [host.alias, host.hostName, host.user]
        .some(value => String(value).toLowerCase().includes(needle.toLowerCase())));
    const ordered = needle === ''
      ? filtered.slice().sort((a, b) => a.alias.localeCompare(b.alias, 'pl'))
      : rankResults(needle, filtered);
    const terminal = findTerminal();
    return ordered.slice(0, LIMIT).map(host => hostResult(host, terminal));
  }

  async function searchUnits(needle) {
    const list = await units();
    return rankUnits(list, needle).map(unitResult);
  }

  async function searchSnippets(needle) {
    const list = snippets();
    const filtered = needle === ''
      ? list
      : list.filter(snippet => [snippet.keyword, snippet.name, snippet.text]
        .some(value => String(value).toLowerCase().includes(needle.toLowerCase())));
    const ordered = needle === ''
      ? filtered.slice().sort((a, b) => a.keyword.localeCompare(b.keyword, 'pl'))
      : rankResults(needle, filtered.map(snippet => ({
          ...snippet,
          title: snippet.name,
        }))).map(item => ({
          keyword: item.keyword,
          name: item.name,
          text: item.text,
        }));
    return ordered.slice(0, LIMIT).map(snippetResult);
  }

  async function searchContainers(needle) {
    const list = await containers();
    const filtered = needle === ''
      ? list
      : list.filter(container => [container.id, container.name, container.image]
        .some(value => String(value).toLowerCase().includes(needle.toLowerCase())));
    const ordered = needle === ''
      ? filtered.slice().sort((a, b) => a.name.localeCompare(b.name, 'pl'))
      : filtered;
    const binary = dockerBinary() || 'docker';
    const terminal = findTerminal();
    return ordered.slice(0, LIMIT)
      .map(container => containerResult(container, binary, terminal));
  }

  return {
    id: PROVIDER_ID,
    title: 'Komendy',
    priority: ProviderPriority.HIGH,
    prefix: '>',
    timeoutMs: 300,
    warmUp() {
      sshHosts();
      snippets();
      units().catch(() => []);
      containers().catch(() => []);
    },
    dispose() {},
    async search(query, context = {}) {
      const original = String(query ?? '').trim();
      const mode = detectMode(original, context?.mode);
      const needle = mode === '' || mode === 'commands'
        ? stripPrefix(original, '')
        : stripPrefix(original, mode);

      if (mode === 'ssh')
        return searchHosts(needle);
      if (mode === 'sys')
        return searchUnits(needle);
      if (mode === 'snip')
        return searchSnippets(needle);
      if (mode === 'docker')
        return searchContainers(needle);

      if (needle === '')
        return [];

      if (scoreResult(needle, { title: needle, key: needle }) <= 0)
        return [];

      return [commandResult(needle)];
    },
    async activate(action) {
      if (!action || typeof action !== 'object')
        return false;

      if (action.type === 'systemd') {
        const method = SYSTEMD_VERBS[action.verb];
        if (!method || !action.unit)
          return false;
        const reply = await callDbus(
          connection,
          SYSTEMD_BUS_NAME,
          SYSTEMD_OBJECT_PATH,
          SYSTEMD_INTERFACE,
          method,
          new GLib.Variant('(ss)', [String(action.unit), 'replace']),
          new GLib.VariantType('(o)'),
          SYSTEMD_TIMEOUT_MS
        );
        return reply !== null;
      }

      if (action.type === 'docker-stop' && Array.isArray(action.argv)) {
        const result = await runProcess(
          action.argv.map(value => String(value)),
          DOCKER_TIMEOUT_MS
        );
        return result.ok;
      }

      return false;
    },
    // Exported for callers/tests that want the same parsing without a search.
    _parseUnitList: parseUnitList,
    _parseContainerList: parseContainerList,
  };
}

export default createProvider;
