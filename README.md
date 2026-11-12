# Spotlight

Launcher w stylu macOS Spotlight dla GNOME Shell (45–51). Jedno pole, wyniki z
aplikacji, otwartych okien, plików (`locate`), paneli Ustawień GNOME, komend
powłoki i kalkulatora — z podglądem, menu akcji i frecency.

Wizualna referencja: `mockup/launcher.html` oraz `mockup/spotlight-*.png`.
Specyfikacja: `docs/DESIGN.md`.

Przy `enable()` rozszerzenie asynchronicznie rozgrzewa cache aplikacji, paneli Ustawień i bazy `locate`, dzięki czemu pierwsze wpisanie nie płaci zimnego kosztu providerów.

## Wymagania

- GNOME Shell 45–51 (testowane na 51.1) i gjs 1.90+.
- `gnome-extensions` (pakiet `gnome-shell`).
- `locate` (pakiet `mlocate`/`plocate`) dla providera plików — bez niego sekcja
  plików jest po prostu pusta.
- Terminal (`gnome-terminal` albo GNOME Console/kgx) dla prefiksu `>`.
- Do testów: `gjs` i `glib-compile-schemas`; do smoke dodatkowo
  `dbus-run-session` i sesyjny GNOME Shell w trybie headless.

## Instalacja

Z katalogu repozytorium:

```bash
bash tools/deploy.sh
```

Skrypt pakuje ZIP (`gnome-extensions pack` ze schematem i `lib/`), instaluje go
przez `gnome-extensions install --force`, wykonuje `disable`/`enable` i sprawdza
`gnome-extensions info`. Sukces oznacza stan `ACTIVE`. Jeśli Shell nie zna UUID
(np. brak sesji GNOME albo rozszerzenie nie było jeszcze włączone), skrypt kończy
się kodem ≠ 0 i komunikatem „zarejestruj UUID po zalogowaniu”.

Wariant z innym UUID (np. do testów obok zainstalowanej wersji):

```bash
bash tools/deploy.sh --uuid-suffix test
```

Dwie kopie (np. `spotlight@haniewicz.dev` i wariant z `--uuid-suffix`) mogą działać jednocześnie, bo nazwy GType są wyprowadzane per UUID.

Po instalacji włącz rozszerzenie w aplikacji „Rozszerzenia” lub:

```bash
gnome-extensions enable spotlight@haniewicz.dev
gnome-extensions prefs spotlight@haniewicz.dev
```

## Skrót

Domyślnie `Super + Space`. Skrót można zmienić w preferencjach (4 warianty:
`Super+Space`, `Super+Enter`, `Ctrl+Space`, `Super+S`). Jeśli Shell ma konflikt
z innym skrótem (np. przełączaniem języka), Shell rozstrzyga go sam — Spotlight
nie nadpisuje cudzych skrótów.

## Prefiksy

- `>` — komendy powłoki, np. `> systemctl --user restart spotify` (uruchamiane
  w terminalu, nigdy bezpośrednio przez proces Shella).
- `f ` — zawężenie do plików, np. `f raport 2024`. Spacja po `f` jest częścią
  prefiksu, dzięki czemu zwykłe zapytania typu `firefox` działają normalnie.
- Bez prefiksu przeszukiwane są wszystkie włączone providery.

## Klawisze

| Klawisz | Akcja |
|---|---|
| `↑` / `↓` | wybór wyniku |
| `Tab` / `Shift+Tab` | następna / poprzednia sekcja |
| `Enter` | akcja domyślna |
| `Ctrl+Enter` | akcja alternatywna (np. kopiuj ścieżkę) |
| `Space` | Quick Look: podgląd obrazu/PDF/tekstu (ponownie `Space` wraca do listy) |
| `Ctrl+K` | menu akcji zaznaczonego wyniku |
| `Ctrl+P` | przypnij/odepnij od „Częste” (flaga w historii użycia) |
| `Esc` | zamknij modal |

Menu akcji zawiera tylko akcje możliwe do wykonania; np. „Uruchom w terminalu”
jest wyszarzone, gdy nie ma zainstalowanego terminala. Zamknięcie menu nie
zamyka modala.

## Preferencje

Okno Adwaita pozwala ustawić skrót, włączać/wyłączać providery, wybrać limit
wyników (suwak 4–12), przełącznik panelu podglądu oraz monitor otwierania
(`pointer` / `focused` / `primary`). Wszystkie wartości są zapisywane przez
`this.getSettings()`; puste lub uszkodzone wartości nie powodują wyjątków.

## Ograniczenia

- Pliki pochodzą z bazy `locate`; rozszerzenie nie buduje własnego indeksu i nie
  obserwuje zmian w systemie plików.
- Brak sieci: kursy walut są tylko z lokalnego cache (`currency-rates`), a ich
  brak oznacza brak wyniku walutowego, nie zmyśloną wartość.
- Brak telemetrii, schowka jako osobnego providera, snippetów i plugin API
  (poza MVP).
- Komendy wymagają terminala; bez niego wynik jest widoczny, ale wyszarzony.
- Panel podglądu pokazuje maksymalnie 6 wierszy metadanych; podgląd tekstu
  pliku jest ograniczony do 200 linii i nie jest edytorem. Obrazy i pierwsze
  strony PDF są miniaturkowane asynchronicznie (GnomeDesktop, z fallbackiem
  `GdkPixbuf` dla obrazów do 20 MB); bez thumbnailera PDF pokazuje
  „brak podglądu PDF”.

## Testy

Bramka akceptacyjna (bez zależności zewnętrznych):

```bash
python3 tests/run_all.py
```

Uruchamia wszystkie `tests/js/*.test.js` przez `gjs -m`, waliduje
`metadata.json`, kompiluje schemat przez `glib-compile-schemas --strict
--dry-run` i sprawdza izolację modułów PURE.

Smoke w izolowanym, headless Shellu (osobne `XDG_*`, `GSETTINGS_BACKEND=memory`,
rozszerzenie skopiowane do tymczasowego `XDG_DATA_HOME`):

```bash
bash tools/headless-smoke.sh
```

Skrypt wypisuje `PASS: modal-open modal-typed modal-esc modal-closed preview-text preview-image` i kończy
się kodem 0. Gdy w środowisku brakuje `gnome-shell` albo nie da się ustawić
`GI_TYPELIB_PATH`, wypisuje `SKIP: <powód>` i kończy się kodem 3. Inne błędy
Shella oznaczają kod ≠ 0.

Bramka wydajnościowa frontendu (ten sam izolowany, headless Shell):

```bash
bash tools/headless-perf.sh
```

Skrypt uruchamia daemon bezpośrednio (`gjs -m searchd/main.js`) w izolowanej
sesji D-Bus, a następnie mierzy modal: synchroniczne pierwsze malowanie z LRU
(`first-paint ≤ 16 ms`), czas wyniku daemona (`≤ 30 ms`) i najdłuższe zacięcie
pętli głównej (`≤ 50 ms`). Po `Quit()` daemona ten sam przebieg sprawdza
fallback in-process (`≤ 120 ms`, stopka `offline`) i kończy się dosłowną linią
`PASS: frontend first-paint<=16ms result<=30ms stall<=50ms fallback<=120ms`.
Wypisuje też linie `BENCH` z surowymi pomiarami. Brak daemona nie blokuje
bramki: mierzy wtedy sam fallback. Brak `gnome-shell`/typelibów daje `SKIP:` i
kod 3.

Benchmark D-Bus daemona (stały klient `gjs`, bez narzutu spawnu `busctl` na
każde zapytanie):

```bash
bash tools/bench-daemon.sh
```

Wypisuje `BENCH` dla 100 wywołań (`p50`/`p95`/`max`) oraz osobno wewnętrzne
`stats.ms` providerów apps/files/settings. Próg: `p95 <= 30 ms`, `max <= 150 ms`.

Limit `max-results` jest wspólny dla wszystkich providerów i stosowany po
rankingu: łącznie powstaje najwyżej N wyników, a sekcja pojedynczego providera
nie przekracza `perProviderLimit` (domyślnie N). Dzięki temu wpisanie jednego
znaku nie tworzy setek wierszy St.

## Daemon vs fallback

Rozszerzenie jest frontendem: po `enable()` sonduje `org.gnome.Spotlight`
(200 ms) i wybiera źródło. W trybie `daemon` wysyła `Search` po D-Bus i
równolegle odpytuje tylko lokalny provider `windows`; nie robi
`get_installed()`, `Gio.AppInfo.get_all()` ani `locate` w ścieżce wpisywania.
Brak daemona, timeout 150 ms lub błąd D-Bus przełącza na dotychczasową ścieżkę
in-process.

Źródło widać w stopce modala:

- `daemon` — wynik przyszedł z `gnome-spotlightd` (obok suma `stats.ms`),
- `offline` — daemon jest zatrzymany albo nie odpowiedział; działa fallback
  lokalny.

Sprawdzenie i przełączanie bez restartu Shella:

```bash
# stan i zatrzymanie daemona systemd --user
systemctl --user status gnome-spotlightd.service
systemctl --user stop gnome-spotlightd.service

# ponowne uruchomienie
systemctl --user start gnome-spotlightd.service

# wariant bez systemd: daemon w tle z repozytorium
gjs -m searchd/main.js &
kill %1
```

Po zatrzymaniu daemona wpisz zapytanie ponownie — stopka pokaże `offline`, a
wyniki nadal się pojawią. Po starcie daemona (`NameOwnerChanged`) rozszerzenie
samo wróci do `daemon`; nie trzeba wyłączać ani włączać rozszerzenia.
`tools/install-daemon.sh` wybiera jednego właściciela nazwy: gdy działa
`systemd --user`, instaluje i uruchamia unit, a plik aktywacji D-Bus usuwa;
bez systemd zostawia wyłącznie aktywację D-Bus.

## Struktura

```
extension.js            # enable/disable, skrót, rejestracja providerów
prefs.js                # okno preferencji Adwaita
metadata.json
stylesheet.css
schemas/                # GSettings
lib/                    # PURE: ranking, fuzzy, text, calculator, format, usage,
                        #       searchStream (merge/stabilize/LRU)
lib/preview-model.js    # PURE: klasyfikacja pliku, metadane, snippet tekstu
lib/daemonClient.js     # Gio.DBus: probe, Search, NameOwnerChanged, cancel
lib/providers/          # aplikacje, okna, ustawienia, komendy, pliki, kalkulator
lib/ui/                 # modal, wiersz wyniku, podgląd, menu akcji
tools/deploy.sh
tools/install-daemon.sh    # daemon: systemd --user albo aktywacja D-Bus
tools/bench-daemon.sh      # 100 wywołań D-Bus stałym klientem gjs
tools/headless-smoke.sh
tools/headless-perf.sh
tests/run_all.py
tests/js/               # testy PURE (gjs -m)
tests/headless/smoke.js # skrypt automatyzacji Shella
tests/headless/perf.js  # first-paint/result/stall daemon + fallback w Shellu
```