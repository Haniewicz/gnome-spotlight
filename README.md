# Spotlight

Launcher w stylu macOS Spotlight dla GNOME Shell (45–51). Jedno pole, wyniki z
aplikacji, otwartych okien, plików (`locate`), paneli Ustawień GNOME, komend
powłoki, kalkulatora i historii schowka — z podglądem, menu akcji i frecency.

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
- `cb ` albo `clip…` — historia schowka, np. `cb raport` albo `clip raport`.
  Wpis pojawia się po otwarciu modala; `Enter` wstawia jego treść z powrotem do
  schowka, a `Ctrl+Enter` usuwa wpis z historii. Historia jest lokalna dla
  Shella i zapisywana w `$XDG_CACHE_HOME/gnome-spotlight/clipboard.json`.
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

### Akcje okien

Na wynikach providera `windows` (okno aplikacji z listy otwartych okien) menu
`Ctrl+K` zawiera akcje geometrii i zarządzania oknem. Wpisy są wyszarzone, gdy
okno nie zgłasza odpowiedniej możliwości (`can_close`, `can_minimize`,
`allows_move`, `allows_resize`, `can_maximize`), więc niedostępna akcja nigdy
nie wykonuje się w tle.

| `id` | Akcja | Warunek aktywności | Wykonanie |
|---|---|---|---|
| `tile-left` | Przytnij w lewo | okno można przesuwać i zmieniać rozmiar | `Meta.Window.tile(Meta.TileMode.LEFT)`, a bez tiling-u `planTile()` + `move_resize_frame()` |
| `tile-right` | Przytnij w prawo | jak wyżej | `Meta.Window.tile(Meta.TileMode.RIGHT)`, a bez tiling-u `planTile()` + `move_resize_frame()` |
| `maximize` | Maksymalizuj | `can_maximize`, okno można przesuwać i zmieniać rozmiar | `Meta.Window.maximize()`, a bez tej metody `planCenter()` (90% pracy) + `move_resize_frame()` |
| `move-workspace-1` … `move-workspace-4` | Przenieś na przestrzeń 1–4 | `allows_move` i istnieje dana przestrzeń | `change_workspace()` + `activate()` |
| `minimize` | Minimalizuj | `can_minimize` | `Meta.Window.minimize()` |
| `close` | Zamknij | `can_close` | `Meta.Window.close()`, a w starszym Mutterze `delete()` |

Planista `lib/window-actions.js` jest czystym modułem (bez `Meta`/`St`), więc
dzieli się na pół ekranu bez 1-px szczeliny również na monitorach o nieparzystej
szerokości i z ujemnym początkiem. Współpracuje z `splittiling@haniewicz.dev`:
gdy Mutter udostępnia `tile()`, to on rozstrzyga geometrię, a planista jest tylko
fallbackiem, więc rozszerzenia nie muszą być włączane razem.

## Preferencje

Okno Adwaita pozwala ustawić skrót, włączać/wyłączać providery, wybrać limit
wyników (suwak 4–12), przełącznik panelu podglądu, monitor otwierania
(`pointer` / `focused` / `primary`), a także włączyć historię schowka i
wyczyścić ją przyciskiem „Wyczyść historię”. Wszystkie wartości są zapisywane
przez `this.getSettings()`; puste lub uszkodzone wartości nie powodują wyjątków.

## Natywne providery GNOME

Daemon konsumuje aplikacje, które same rejestrują się jako
`org.gnome.Shell.SearchProvider2`. Deskryptory są czytane przy starcie z:

- `~/.local/share/gnome-shell/search-providers/*.ini` (użytkownika),
- `/usr/share/gnome-shell/search-providers/*.ini` (systemowe).

Wyniki trafiają do osobnych sekcji `remote:<BusName>` (np.
`remote:org.gnome.Settings.SearchProvider`, `remote:org.gnome.Calculator.SearchProvider`)
z rodzajem `Natywne`. Launcher nie uruchamia aplikacji przy wpisywaniu i nie
odpytuje nieuruchomionych providerów: najpierw sprawdzany jest właściciel nazwy
D-Bus (`NameHasOwner`), a bez właściciela provider jest pomijany bez wpisu w
`errors` (licznik `skipped`). Proxy powstaje z `DO_NOT_AUTO_START` i
`DO_NOT_LOAD_PROPERTIES`, więc `AutoStart=true` z pliku `.ini` nie omija tej
reguły. Każde wywołanie `GetInitialResultSet` i `GetResultMetas` ma budżet
80 ms, cały provider `remote` odpowiada w maksymalnie 100 ms, a z remote
wracają najwyżej 3 najlepiej ocenione wyniki (dedupe po `busName + remoteId`).
Błąd albo timeout jednego providera nie usuwa wyników pozostałych. Własny bus
name `org.gnome.Spotlight` jest pomijany, podobnie jak deskryptory bez
`BusName`/`ObjectPath`.

Lista znalezionych plików bez uruchamiania daemona:

```bash
ls ~/.local/share/gnome-shell/search-providers/*.ini \
   /usr/share/gnome-shell/search-providers/*.ini 2>/dev/null
```

Aby wyłączyć konsumowanie natywnych aplikacji, użyj przełącznika
„Wyniki z natywnych aplikacji (Ustawienia, Kalkulator…)” w preferencjach
(klucz GSettings `remote-providers-enabled`, domyślnie `true`). Zmiana jest
czytana przy starcie daemona; po przełączeniu uruchom go ponownie:

```bash
systemctl --user restart gnome-spotlightd.service
# wariant bez systemd: zatrzymaj i uruchom ponownie `gjs -m searchd/main.js`
```

## Ograniczenia

- Pliki pochodzą z bazy `locate`; rozszerzenie nie buduje własnego indeksu i nie
  obserwuje zmian w systemie plików.
- Brak sieci: kursy walut są tylko z lokalnego cache (`currency-rates`), a ich
  brak oznacza brak wyniku walutowego, nie zmyśloną wartość.
- Brak telemetrii, snippetów i plugin API (poza MVP). Historia schowka jest
  lokalna (maks. 100 wpisów / 64 KiB na wpis, TTL 7 dni) i nie jest wysyłana do
  daemona.
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

Skrypt wypisuje `PASS: window-actions modal-open modal-typed modal-esc
modal-closed preview-text preview-image clipboard-item` i kończy się kodem 0
(zachowana jest też starsza linia bez `window-actions` dla dotychczasowych
wrapperów). Gdy w środowisku brakuje `gnome-shell` albo nie da się ustawić
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
                        #       clipboard-store, searchStream (merge/stabilize/LRU)
lib/preview-model.js    # PURE: klasyfikacja pliku, metadane, snippet tekstu
lib/daemonClient.js     # Gio.DBus: probe, Search, NameOwnerChanged, cancel
lib/providers/          # aplikacje, okna, ustawienia, komendy, pliki, kalkulator,
                        #       schowek (Shell-local, bez zmian w daemonie)
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