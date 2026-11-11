import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import { scoreResult } from '../ranking.js';
import { ProviderPriority } from './registry.js';

const PROVIDER_ID = 'commands';
const TERMINAL_MISSING_DESCRIPTION =
  'Nie znaleziono gnome-terminal ani kgx — zainstaluj terminal, aby uruchamiać komendy.';

function findTerminal() {
  if (GLib.find_program_in_path('gnome-terminal'))
    return { id: 'gnome-terminal', label: 'gnome-terminal' };
  if (GLib.find_program_in_path('kgx'))
    return { id: 'kgx', label: 'GNOME Console' };
  return null;
}

function terminalArgv(terminal, command) {
  if (terminal.id === 'kgx')
    return ['kgx', '-e', 'bash', '-lc', command];
  return ['gnome-terminal', '--', 'bash', '-lc', command];
}

function spawnInTerminal(terminal, command) {
  // The user command is only ever handed to a terminal, never executed
  // directly by the Shell process.
  const launcher = new Gio.SubprocessLauncher({
    flags: Gio.SubprocessFlags.NONE,
  });
  launcher.spawnv(terminalArgv(terminal, command));
}

async function copyText(text) {
  try {
    const { default: St } = await import('gi://St');
    St.Clipboard.get_default().set_text(
      St.ClipboardType.CLIPBOARD,
      String(text ?? '')
    );
  } catch {
    // Clipboard access is best effort.
  }
}

function commandResult(command, terminal) {
  const id = `command:${command}`;
  const base = {
    id,
    providerId: PROVIDER_ID,
    title: `Uruchom: ${command}`,
    kind: 'Komenda',
    icon: 'utilities-terminal-symbolic',
    key: command,
    usageKey: `commands:${command}`,
    preview: {
      rows: [
        ['Polecenie', command],
        ['Terminal', terminal?.label ?? 'brak'],
      ],
      description: terminal
        ? `Polecenie zostanie uruchomione w ${terminal.label}.`
        : TERMINAL_MISSING_DESCRIPTION,
    },
  };

  if (!terminal) {
    return {
      ...base,
      subtitle: TERMINAL_MISSING_DESCRIPTION,
      description: TERMINAL_MISSING_DESCRIPTION,
      disabled: true,
      actions: {},
    };
  }

  return {
    ...base,
    subtitle: `W terminalu: ${terminal.label}`,
    description: `Polecenie zostanie uruchomione w ${terminal.label}.`,
    actions: {
      primary: () => {
        const current = findTerminal() ?? terminal;
        spawnInTerminal(current, command);
      },
      secondary: () => copyText(command),
      menu: [
        {
          id: 'run-terminal',
          label: 'Uruchom w terminalu',
          callback: () => {
            const current = findTerminal() ?? terminal;
            spawnInTerminal(current, command);
          },
        },
        {
          id: 'copy-command',
          label: 'Kopiuj polecenie',
          callback: () => copyText(command),
        },
      ],
    },
  };
}

/**
 * Shell-command provider for the ">" prefix. Terminal discovery happens per
 * search; without a terminal the result is marked disabled instead of
 * throwing. Commands are always launched inside a terminal.
 */
export function createProvider() {
  return {
    id: PROVIDER_ID,
    title: 'Komendy',
    priority: ProviderPriority.HIGH,
    prefix: '>',
    timeoutMs: 300,
    search(query) {
      const command = String(query ?? '').trim();
      if (command === '')
        return [];

      if (scoreResult(command, { title: command, key: command }) <= 0)
        return [];

      return [commandResult(command, findTerminal())];
    },
  };
}

export default createProvider;