import St from 'gi://St';

import { parseQuery } from '../calculator.js';
import { ProviderPriority } from './registry.js';

const PROVIDER_ID = 'calculator';

function copyText(text) {
  try {
    const clipboard = St.Clipboard.get_default();
    const value = String(text ?? '');
    if (value !== '')
      clipboard.set_text(St.ClipboardType.CLIPBOARD, value);
  } catch {
    // Clipboard access is best effort; the result stays usable.
  }
}

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
  const unitRow = parsed.kind === 'unit'
    ? parsed.note
    : parsed.kind === 'timezone'
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
    usageKey: `calculator:${query}`,
    actions: {
      primary: () => copyText(display),
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

/**
 * Calculator provider. Currency rates are injected through the factory
 * options or the search context; this module never performs network I/O.
 */
export function createProvider(options = {}) {
  return {
    id: PROVIDER_ID,
    title: 'Kalkulator',
    priority: ProviderPriority.HIGH,
    prefix: null,
    timeoutMs: 300,
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