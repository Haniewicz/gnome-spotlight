// Daemon-side shell-command provider. It deliberately never spawns a terminal:
// the daemon only describes what the extension client should run.
import { scoreResult } from '../../lib/ranking.js';
import { ProviderPriority } from '../../lib/providers/registry.js';

const PROVIDER_ID = 'commands';
const TERMINAL_MISSING_DESCRIPTION =
  'Polecenie zostanie uruchomione w terminalu przez klienta rozszerzenia.';

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

export function createProvider() {
  return {
    id: PROVIDER_ID,
    title: 'Komendy',
    priority: ProviderPriority.HIGH,
    prefix: '>',
    timeoutMs: 300,
    dispose() {},
    search(query) {
      const command = String(query ?? '').trim();
      if (command === '')
        return [];

      if (scoreResult(command, { title: command, key: command }) <= 0)
        return [];

      return [commandResult(command)];
    },
  };
}

export default createProvider;