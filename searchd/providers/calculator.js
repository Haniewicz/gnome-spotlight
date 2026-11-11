// Daemon-side calculator provider. The parser and unit/currency logic live in
// the shared PURE lib/calculator.js module and are reused unchanged.
import { parseQuery } from '../../lib/calculator.js';
import { ProviderPriority } from '../../lib/providers/registry.js';

const PROVIDER_ID = 'calculator';

function sourceLabel(kind) {
  switch (kind) {
  case 'currency':
    return 'cache kursów (bez sieci)';
  case 'timezone':
    return 'Intl.DateTimeFormat (ICU)';
  case 'unit':
    return 'tabela jednostek';
  default:
    return 'parser wyrażeń';
  }
}

function resolveRates(options, context) {
  const candidates = [
    context?.rates,
    context?.currencyRates,
    options.rates,
    typeof options.getRates === 'function' ? options.getRates() : null,
  ];

  for (const candidate of candidates) {
    if (candidate && typeof candidate === 'object')
      return candidate;
  }
  return null;
}

function toResult(parsed, query) {
  const display = String(parsed.display ?? parsed.value ?? '');
  const unitRow = parsed.kind === 'unit' || parsed.kind === 'timezone'
    ? parsed.note
    : '—';
  const rateRow = parsed.kind === 'currency' ? parsed.note : '—';

  return {
    id: `calculator:${query}`,
    providerId: PROVIDER_ID,
    title: display,
    subtitle: query,
    kind: 'Kalkulator',
    icon: 'accessories-calculator-symbolic',
    key: query,
    path: '',
    activation: { type: 'copy', text: display },
    actions: {
      primary: {
        id: 'copy-result',
        label: 'Kopiuj wynik',
        type: 'copy',
        text: display,
      },
      secondary: {
        id: 'copy-expression',
        label: 'Kopiuj wyrażenie',
        type: 'copy',
        text: query,
      },
      menu: [
        {
          id: 'copy-result',
          label: 'Kopiuj wynik',
          type: 'copy',
          text: display,
        },
        {
          id: 'copy-expression',
          label: 'Kopiuj wyrażenie',
          type: 'copy',
          text: query,
        },
      ],
    },
    preview: {
      rows: [
        ['Wyrażenie', query],
        ['Wynik', display],
        ['Jednostka', unitRow],
        ['Kurs', rateRow],
        ['Źródło', sourceLabel(parsed.kind)],
      ],
      description: parsed.note || display,
    },
    parsed,
  };
}

export function createProvider(options = {}) {
  return {
    id: PROVIDER_ID,
    title: 'Kalkulator',
    priority: ProviderPriority.HIGH,
    prefix: null,
    timeoutMs: 300,
    dispose() {},
    search(query, context = {}) {
      const needle = String(query ?? '').trim();
      if (needle === '')
        return [];

      const parsed = parseQuery(needle, resolveRates(options, context));
      if (!parsed)
        return [];

      return [toResult(parsed, needle)];
    },
  };
}

export { toResult };
export default createProvider;