# Spotlight dla GNOME Shell — specyfikacja wdrożenia (MVP)

Dokument jest źródłem prawdy dla kart Kanban boardu `dev`. Karta, która go sprzecza,
jest zepsuta — nie odwrotnie.

## 1. Cel

Rozszerzenie GNOME Shell dające launcher w stylu macOS Spotlight: jeden skrót, jedno pole,
natychmiastowe wyniki z wielu źródeł, podgląd i akcje. Wygląd referencyjny: `mockup/launcher.html`
(zrzuty: `mockup/spotlight-results.png`, `mockup/spotlight-calc.png`).

Zakres MVP = to, co widać na makiecie:

- aplikacje (uruchamianie i przełączanie na otwarte okno),
- otwarte okna (przełączanie),
- pliki (przez `locate`),
- panele Ustawień GNOME,
- komendy powłoki (prefiks `>`),
- kalkulator: wyrażenia, jednostki, waluty, strefy czasowe,
- podgląd zaznaczonego wyniku (panel boczny),
- akcje: `⏎` domyślna, `Ctrl+⏎` alternatywna, `Space` podgląd, `Ctrl+K` menu akcji,
- ranking fuzzy + frecency (częstość i świeżość użycia),
- preferencje (skrót, providery, liczba wyników).

Poza MVP (nie implementować, nie „przy okazji”): indeks plików (FTS5/inotify), provider AI,
plugin API, schowek, snippets, publikacja na extensions.gnome.org.

## 2. Stack i środowisko

- GNOME Shell 51.1, Fedora 45, gjs 1.90 (`/usr/sbin/gjs`).
- GJS w trybie ESM (`import ... from 'gi://St'`), bez `resource:///org/gnome/shell/...` poza
  importami dozwolonymi: `resource:///org/gnome/shell/ui/main.js`, `.../ui/popupMenu.js`,
  `.../misc/extensionUtils.js`, `.../ui/shellEntry.js`.
- Brak zależności zewnętrznych: **zero npm, pip, cargo, meson**. Kod + schemat GSettings + testy.
- UUID: `spotlight@haniewicz.dev`. `metadata.json` → `shell-version: ["45","46","47","48","49","50","51"]`,
  `settings-schema: org.gnome.shell.extensions.spotlight`, `gettext-domain` pomijamy.
- Nazwy klas GObject dostają prefiks `Spotlight` (np. `SpotlightModal`) — GType muszą być unikalne
  w procesie Shella.

## 3. Struktura plików

```
extension.js                     # enable/disable, ESM entry
prefs.js                         # okno preferencji (Adwaita)
metadata.json
stylesheet.css
schemas/org.gnome.shell.extensions.spotlight.gschema.xml
lib/ranking.js                   # PURE: scoring, sortowanie, frecency
lib/fuzzy.js                     # PURE: dopasowanie i pozycje trafień
lib/text.js                      # PURE: fold diakrytyków, normalizacja
lib/calculator.js                # PURE: parser wyrażeń, jednostki, waluty (kursy wstrzykiwane)
lib/format.js                    # PURE: skracanie ścieżek, formatowanie liczb PL
lib/usage.js                     # PURE: model historii użyć (serializacja JSON)
lib/providers/registry.js        # PURE: rejestr providerów, kolejność sekcji, dedupe, timeout
lib/providers/apps.js            # gi://Shell / Gio.AppInfo
lib/providers/windows.js         # gi://Shell WindowTracker
lib/providers/settings.js        # Gio.Settings paneli GNOME
lib/providers/commands.js        # prefiks ">"
lib/providers/files.js           # Gio.Subprocess -> locate
lib/providers/calculator.js      # opakowanie lib/calculator.js na Result
lib/ui/modal.js                  # St: overlay, entry, lista, sekcje
lib/ui/resultRow.js              # St: pojedynczy wiersz
lib/ui/preview.js                # St: panel podglądu
lib/ui/actions.js               # menu akcji (Ctrl+K)
tools/deploy.sh                  # pakowanie + instalacja + disable/enable
tools/headless-smoke.sh          # test w izolowanym Shellu (headless + automation-script)
tests/run_all.py                 # runner bramki (bez zależności)
tests/js/*.test.js               # testy modułów PURE (uruchamiane przez gjs -m)
tests/js/harness.js              # mini assert/describe (bez zależności)
```

**Zasada twarda:** moduły oznaczone `PURE` nie importują niczego z `gi://` ani
`resource:///org/gnome/shell`. Dzięki temu bramka (`gjs -m`) działa bez sesji Shella.
Każde odstępstwo = karta wraca.

## 4. Kontrakt providera

```js
// lib/providers/registry.js
export const ProviderPriority = { HIGH: 0, NORMAL: 10, LOW: 20 };

/**
 * @typedef {object} SearchResult
 * @property {string} id            // unikalne w obrębie providera
 * @property {string} providerId    // 'apps' | 'windows' | ...
 * @property {string} title
 * @property {string} [subtitle]
 * @property {string} [kind]        // etykieta po prawej: "Aplikacja", "Plik", ...
 * @property {string|GIcon} [icon]  // nazwa ikony albo GIcon
 * @property {number} [score]       // surowy score providera; ranking dolicza fuzzy
 * @property {string} [key]         // tekst do fuzzy-matchingu (domyślnie title)
 * @property {object} [actions]     // { primary, secondary, menu: [...] }
 * @property {object} [preview]     // { rows: [[label, value]], description }
 */

/**
 * @typedef {object} Provider
 * @property {string} id
 * @property {string} title        // nagłówek sekcji
 * @property {number} priority
 * @property {string|null} prefix  // np. '>' dla komend; null = zawsze
 * @property {(query: string, ctx: object) => Promise<SearchResult[]>} search
 * @property {number} [timeoutMs]  // domyślnie 300
 */
```

Reguły wykonania:

1. `registry.search(query)` odpala wszystkich pasujących providerów **równolegle**, każdy w
   `Promise.race` z timeoutem (`timeoutMs`, domyślnie 300 ms).
2. Provider, który rzucił wyjątek albo przekroczył timeout, jest pomijany; błąd ląduje w
   `ctx.errors` i **nie** przerywa wyszukiwania.
3. Wyniki providerów są scalane, deduplikowane po `providerId + id`, oceniane rankingiem
   i sortowane; sekcje układane wg `priority`, a w sekcji wg score.
4. Puste sekcje nie są renderowane. Gdy wszystko puste → stan „brak wyników” z podpowiedziami prefiksów.
5. Prefiks: gdy query zaczyna się od `prefix` providera (np. `>`), tylko ten provider dostaje
   zapytanie (bez prefiksu); providery bez prefiksu dostają zapytanie **bez** zmiany.

## 5. Ranking (mierzalny)

`lib/fuzzy.js`:

- `fold(text)` — lowercase + mapowanie diakrytyków PL/łacińskich (`ą→a`, `ć→c`, `ę→e`, `ł→l`,
  `ń→n`, `ó→o`, `ś→s`, `ź→z`, `ż→z`, `ä→a`, `ö→o`, `ü→u`, `ß→ss`).
- `matchPositions(query, target)` → `{matched: boolean, positions: number[], runs: number, span: number}`;
  dopasowanie podciągu (subsequence) po `fold`, bez wielkości liter.

`lib/ranking.js`:

- Bazowy score dopasowania (im wyżej, tym lepiej):
  - dokładna równość: 1000
  - prefiks całości: 700
  - początek słowa: 400
  - zawiera jako ciągły fragment: 250
  - podciąg rozproszony: 120
  - bonus za ciągłość dopasowania: `+20 * runs`, kara za rozrzut: `-min(span, 200) * 0.5`
- Boost frecency: `+min(usage, 50) * 2`, plus świeżość: `+40` jeśli użyte <1 h, `+20` <24 h,
  `+10` <7 dni (na podstawie `lastUsed` epoch ms).
- Kara: `+0` dla dopasowania tylko po `key`; tytuł zawsze waży pełną stawkę.
- Sort: `score` malejąco, remis → `usage` malejąco, remis → `title` rosnąco (localeCompare `pl`).
- Funkcje: `scoreResult(query, result, usageEntry)`, `rankResults(query, results, usageMap)`.
  `rankResults` nie mutuje wejścia (test na to).

## 6. Kalkulator (bez `eval`)

`lib/calculator.js`:

- `parseExpression(input)` → AST albo `null`; obsługuje `+ - * / ^ ( )`, liczby z `,`/`.` i separatorem
  tysięcy, procenty (`10% of 250`, `250 + 10%`), nawiasy, unarne minusy.
- `evaluate(ast)` → liczba; dzielenie przez zero → błąd, nie `Infinity`.
- `convert(value, fromUnit, toUnit)` → liczba; jednostki: długość, masa, temperatura (z offsetem),
  objętość, czas, dane cyfrowe, prędkość.
- `parseQuery(text, rates)` → `{ kind: 'expression'|'unit'|'currency'|'timezone', value, display, note }`
  albo `null`. Kursy walut wchodzą parametrem `rates` (`{base:'EUR', rates:{PLN:4.26,...}, asOf}`) —
  moduł PURE, sieci nie dotyka. Brak kursu → `null` (provider pokaże „brak kursu”, nie zmyśloną liczbę).
- Strefy czasowe: `parseQuery("18:00 CET in Tokyo")` → czas lokalny w strefie docelowej przez
  biegłe `Intl.DateTimeFormat` (gjs ma ICU); brak strefy → `null`.

## 7. UI

- Modal: `St.Widget` w `Main.uiGroup`, `style_class = 'spotlight-modal'`, szerokość 860 px,
  wyśrodkowany poziomo, górna krawędź na 14% wysokości monitora, `Shell.ModalDialog`-owy grab
  (`Main.pushModal(actor)`) i `Main.popModal()` w `close()`; brak wycieków grabów (podwójne `close()`
  jest bezpieczne).
- Pole: `St.Entry` z `can_focus = true`, karetką i ikoną lupy; wpisywanie nie może gubić znaków
  (test headless: wpisz „spo”, odczytaj 3 znaki).
- Lista: sekcje `style_class = 'spotlight-section'`, wiersze `'spotlight-row'`,
  zaznaczenie `'spotlight-row-selected'`; nawigacja `Up`/`Down`/`Tab` (następna sekcja) bez zawijania
  w obrębie sekcji poza jej granice; `Enter`/`Ctrl+Enter`/`Space`/`Escape`.
- Podgląd (296 px, prawa kolumna): duża ikona, tytuł, typ, metadane, dwa przyciski akcji.
  Renderuje się tylko gdy `preview-enabled` i wynik ma `preview`.
- Styl: ciemny panel `rgba(26,27,34,0.93)`, promień 18 px, obramowanie `rgba(255,255,255,0.11)`,
  cień, akcent `#3584e4`, font z motywu (`font-family` z `stylesheet.css` nie nadpisujemy —
  dziedziczymy). Wartości z makiety, tolerancja ±2 px.
- Skrót: `Main.wm.addKeybinding('toggle-keybinding', settings, Meta.KeyBindingFlags.NONE,
  Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW, handler)`; w `disable()` zawsze
  `removeKeybinding`. Domyślnie `['<Super>space']`. Konflikt z „przełącz języki”: nie nadpisujemy,
  tylko logujemy ostrzeżenie i modal nadal działa z prefiksem wpisanym ręcznie — obsługę konfliktu
  robi Shell (mux przez `allowKeybinding`), nie nasz kod.

## 8. GSettings (`org.gnome.shell.extensions.spotlight`)

| klucz | typ | domyślnie | znaczenie |
|---|---|---|---|
| `toggle-keybinding` | `as` | `['<Super>space']` | skrót otwierania |
| `enabled-providers` | `as` | `['apps','windows','files','settings','commands','calculator']` | aktywne providery |
| `max-results` | `i` | `8` | limit wyników na zapytanie |
| `preview-enabled` | `b` | `true` | panel podglądu |
| `usage-history` | `s` | `'{}'` | JSON `{ "<providerId>:<id>": {"count": n, "lastUsed": ms} }` |
| `currency-rates` | `s` | `'{}'` | cache kursów `{base, rates, asOf}` |
| `open-on-monitor` | `s` | `'pointer'` | `pointer` \| `focused` \| `primary` |

## 9. Bramka (tests)

`python3 tests/run_all.py` — bez zależności zewnętrznych, kod wyjścia 0 = zielono:

1. Uruchamia każdy `tests/js/*.test.js` przez `gjs -m <plik>`; niezerowy kod = FAIL (wypisuje stderr).
2. Waliduje `metadata.json` (UUID, `shell-version` zawiera `"51"`, `settings-schema`).
3. `glib-compile-schemas --strict --dry-run schemas/` — musi przejść.
4. Sprawdza, że pliki `lib/**` oznaczone `PURE` nie zawierają `gi://` ani `resource://` (grep w Pythonie).
5. Sprawdza, że każdy plik `.js` w repo parsuje się w gjs: dla plików z importami `gi://` test
   pomija sprawdzenie składni (nie da się zaimportować poza Shellem) — dlatego logika MUSI być w `PURE`.

Minimalny zbiór testów po kartach: ranking/fuzzy/text (karta 1), registry (karta 2),
calculator/format/files-parsing/usage (karta 3).

## 10. Podział na karty

| # | Zakres | Kryteria akceptacji (skrót) |
|---|---|---|
| 1 | Szkielet: metadata, schemat, extension.js, modal, skrót, styl, ranking+fuzzy+text+usage z testami | bramka zielona; 12+ przypadków fuzzy/ranking w tym diakrytyki PL; schemat kompiluje się; modal otwiera się i zamyka (headless); brak `gi://` w PURE |
| 2 | Providery apps, windows, settings, commands + registry z timeoutem i dedupe | testy registry (timeout, wyjątek, dedupe, kolejność sekcji); brak blokowania (async); `Shell.AppSystem`/`WindowTracker` użyte przez `lookup_app()` |
| 3 | Pliki (`locate`), kalkulator, historia użyć (frecency) | testy parsera kalkulatora (≥10), jednostek, parsowania `locate`, serializacji historii; brak `eval`; brak sieci w testach |
| 4 | Podgląd, akcje, preferencje, `deploy.sh`, `headless-smoke.sh`, README | smoke w headless Shell: enable → skrót → modal → „spo” → 3 znaki → Esc → disable bez błędów w logu; deploy pakuje i instaluje |

Karty 2–4 startują po scaleniu poprzedniej (wspólne pliki → konflikt worktree).

## 11. Deploy i weryfikacja

- `tools/deploy.sh [--uuid-suffix X]`: `gnome-extensions pack --schema=... --extra-source=lib --extra-source=...`,
  `gnome-extensions install --force`, `disable/enable`, `gnome-extensions info` → wymaga stanu `ACTIVE`.
- `tools/headless-smoke.sh`: `dbus-run-session -- gnome-shell --headless --virtual-monitor=1280x720
  --wayland --automation-script=tests/headless/smoke.js` z izolowanym `XDG_DATA_HOME`/`GSETTINGS_BACKEND=memory`
  i `GI_TYPELIB_PATH=/usr/lib64/gnome-shell:/usr/lib64/mutter-*`.
- Kod rozszerzenia nie może blokować pętli głównej: żadnych synchronicznych `subprocess.wait()`
  bez timeoutu, żadnego `locate` dłuższego niż 300 ms (zabij proces po timeoutcie).

## 12. Ograniczenia i zakazy

- Brak `git push`, brak publikacji release bez zgody właściciela.
- Brak telemetrii i sieci w kodzie poza opcjonalnym pobraniem kursów walut (karta 3: tylko cache
  lokalny; sieci nie dodajemy).
- Zero `eval`/`Function` w kalkulatorze.
- Nie zmieniaj `mockup/` (to referencja wizualna).
- Nie dodawaj plików poza strukturą z §3 bez uzasadnienia w summary.