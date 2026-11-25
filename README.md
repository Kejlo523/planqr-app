# PlanQR — aplikacja

- `frontend/` zawiera React, Nginx i Dockerfile frontendu.
- `backend/` zawiera API TypeScript, proces Kantech, migracje Prisma i Dockerfile backendu.
- `docker-compose.yml` uruchamia aplikację, a `compose.local.yml` dodaje symulatory i połączenie z lokalną bazą. PostgreSQL i jego Compose są w sąsiednim repozytorium `planqr-db`.

W `legacy/kantech-python/` jest wcześniejszy klient SmartService, przydatny do porównania danych z czytnika podczas pilotażu.

## Uruchomienie lokalne na Windows

Umieść oba repozytoria obok siebie. Uruchom Docker Desktop z WSL 2 i w katalogu `planqr-app` wykonaj w PowerShellu:

```powershell
.\local\start.ps1
```

Skrypt tworzy lokalne sekrety, certyfikat HTTPS, bazę z migracjami i symulatory Kantecha, Planu ZUT oraz LDAP. Przeglądarka może poprosić o zaakceptowanie lokalnego certyfikatu. Otwórz `https://localhost:8443/adminpanel/kantech` i zaloguj się jako `pilot-admin`. Hasło to `LDAP_FIXTURE_PASSWORD` z `.env.local`. Opcja `-Mode observe` uruchamia sam podgląd odbić.

Podgląd dydaktyka pobiera prawdziwy plan z `plan.zut.edu.pl`. Karty i zajęcia przypisane do kont testowych korzystają z lokalnego symulatora, ustawionego przez `ZUT_ATTENDANCE_SCHEDULE_URL`.

Do zasymulowania odbicia użyj lokalnego symulatora:

```powershell
function Test-Tap($Number, $Reader = '49919') {
    $body = @{ alias = "WISYNC_$Number"; readerId = $Reader } | ConvertTo-Json -Compress
    Invoke-RestMethod 'http://127.0.0.1:18700/test/scans' -Method Post -ContentType 'application/json' -Body $body
}
Test-Tap 1
Test-Tap 2
Test-Tap 3
Start-Sleep -Seconds 3
Test-Tap 1 '49921'
```

Karta `1` należy do prowadzącego, `2` do studenta, `3` do gościa. Domyślne testowe zajęcia mają ID `9001` i zaczynają się pięć minut po starcie symulatora. Pod `/attendance/9001` lista odświeża się automatycznie, a XLSX jest dostępny od otwarcia. Symulator ma pary `49919 → 49921` i `49920 → 49922` dla dwóch sal.

## API Kantech

Obie metody pod `/api/kantech/events` wymagają zalogowania przez LDAP i roli administratora w PlanQR. Zaloguj się przez `POST /api/auth/login`, a potem przekazuj otrzymane cookie `jwt` lub nagłówek `Authorization: Bearer <JWT>`.

| Metoda | Wejście | Odpowiedź |
| --- | --- | --- |
| `GET /api/kantech/events` | Opcjonalne `readerId` i `limit` od 1 do 100 | JSON z trybem, stanem czytników i zdarzeniami |
| `POST /api/kantech/events` | Odbicie albo paczka z `readerId`, `state` i `events` | `204` po przyjęciu, `400` dla błędnych danych, `401` lub `403` przy braku uprawnień |

Przykładowe pojedyncze odbicie testowe:

```json
{
  "readerId": "49919",
  "alias": "WISYNC_2",
  "occurredAt": "2026-11-18T09:00:00Z",
  "granted": true
}
```

Opcjonalny `key` identyfikuje zdarzenie jako 64 znaki szesnastkowe SHA-256. Przy jego braku backend wylicza klucz z treści odbicia. Tryb `observe` służy do obserwacji. Tryb `attendance` zapisuje kwalifikujące się odbicia od `KANTECH_ACTIVE_FROM`.

W zakładce **Odczyty na żywo** administrator LDAP może zmienić tryb przez przełącznik **Automatyczny zapis obecności**. `POST /api/kantech/events/mode` przyjmuje `{"mode":"observe"}` lub `{"mode":"attendance"}`. Zmiana zapisana w bazie obowiązuje bez restartu. Po włączeniu zapisu obowiązuje czas przełączenia, a po wyłączeniu kolejne odbicia trafiają do podglądu. Tryb serwera `off` wyłącza całą obsługę odczytu.

W domyślnym trybie `KANTECH_TRANSPORT=http` proces czytnika wysyła ten sam format do wewnętrznego `POST /internal/kantech` z nagłówkiem `Authorization: Bearer <WORKER_SECRET_TOKEN>` i odświeża listę przez `GET /internal/kantech/readers`.

Administrator LDAP w zakładce **Czytniki** pod `/adminpanel/kantech?view=readers` tworzy grupę i wybiera urządzenia ze spisu SmartService. PlanQR pobiera identyfikatory czytników według oznaczenia RCP i adresu urządzenia w etykietach `Doors`. Każdy czytnik w grupie ma rolę wejścia, wyjścia albo obu kierunków. Dotychczasowe konfiguracje par i pojedynczych czytników działają do czasu przeniesienia ich do grupy.

`GET /api/kantech/readers/groups` zwraca zapisane grupy i urządzenia wykryte w SmartService. `POST /api/kantech/readers/groups` zapisuje `name`, listę `devices` z ich `id` oraz `readers: [{ id, role }]`. Role to `ENTRY`, `EXIT` i `BOTH`. Opcjonalne `id` wskazuje edytowaną grupę. `DELETE /api/kantech/readers/groups/:id` usuwa grupę.

`GET /api/kantech/readers` zwraca listę. `POST /api/kantech/readers/setup` przyjmuje `entry` i `exit` w formacie `{ id, label }`, `buildingId`, `roomNumber` oraz opcjonalne `edit`. Wartość `exit: null` jawnie wybiera tryb jednego czytnika. Dotychczasowy `POST /api/kantech/readers` nadal obsługuje pojedyncze rekordy. `DELETE /api/kantech/readers/:id` usuwa czytnik. W trybie `attendance` prowadzący otwiera listę na wejściu, a uczestnik jest zapisywany najwyżej raz.

W bocznym panelu **Czytniki w SmartService** widać wszystkie urządzenia zwrócone przez `Doors`, także bez przypisania w PlanQR. Worker odświeża listę co minutę, a stan odczytuje z `ComponentFullStatus`. `GET /api/kantech/readers/inventory` zwraca ostatnią listę z czasem odczytu administratorowi LDAP. Jeżeli odczyt się nie powiedzie, panel po dwóch minutach oznacza dane jako nieaktualne.

Jawne przypisania aliasów, np. `WISYNC_5`, mają pierwszeństwo przed automatycznym rozpoznaniem. Karta studenta w formacie `s<numer albumu>` jest rozpoznawana bez przypisania, a cyfry po `s` trafiają na listę jako numer albumu. Dla prowadzącego aplikacja korzysta z imienia i nazwiska z pamięci LDAP. Przy braku profilu szuka w Planie ZUT jednoznacznego dopasowania inicjału i nazwiska z loginu. Zajęcia wybiera z planu prowadzącego według godziny odbicia karty.

Odczyt karty z adresem w domenie ZUT jest rozpoznawany po loginie przed `@`. Prowadzący otwiera listę na wejściu. Studenci i pozostali prowadzący mogą dopisać się raz przez dowolny czytnik grupy. Listę zamyka osoba, która ją otworzyła, po odbiciu na wyjściu w tej grupie. Czytnik dwukierunkowy pozwala zamknąć listę po upływie co najmniej 60 sekund od otwarcia. Nowe listy zamykają się automatycznie 30 minut przed końcem zajęć. W panelu obecności wyświetlamy login oraz imię i nazwisko z LDAP, gdy profil jest dostępny.

Wartości z `KANTECH_DOOR_IDS` służą do jednorazowego importu po uruchomieniu backendu, jeśli baza nie ma jeszcze zapisanych czytników.

### Połączenie workera z PostgreSQL

Ustaw `KANTECH_TRANSPORT=postgres` i `KANTECH_DATABASE_URL` w prywatnym `.env`. Po migracji i zapisaniu czytników worker pobiera ich konfigurację z PostgreSQL oraz zapisuje odczyty i stan czytników bez połączenia z API PlanQR. Źródłem zdarzeń jest SmartService. Ustawienie z panelu ma pierwszeństwo przed trybem z `.env`. Backend przetwarza kolejkę zgodnie z trybem zapisanym przy odbiorze każdego zdarzenia.

Nadaj osobnemu użytkownikowi workera dostęp do bazy PlanQR i poniższe uprawnienia po migracji. W lokalnym Compose tryb `postgres` domyślnie korzysta z połączenia do bazy testowej.

```sql
GRANT USAGE ON SCHEMA public TO planqr_kantech;
GRANT SELECT (id) ON "AttendanceReader" TO planqr_kantech;
GRANT INSERT ON "KantechEvent" TO planqr_kantech;
GRANT SELECT, INSERT, UPDATE ON "KantechReaderStatus" TO planqr_kantech;
GRANT SELECT, INSERT, UPDATE ON "KantechInventory" TO planqr_kantech;
GRANT SELECT ON "KantechCaptureSettings" TO planqr_kantech;
```

Panel Kantecha i raport odczytują te same dane. Kontu raportowemu wystarczy `USAGE` na schemacie i `SELECT` na widoku `"KantechReadings"`.

```sql
SELECT "occurredAt", "receivedAt", "readerId", alias, granted, outcome
FROM "KantechReadings"
ORDER BY "receivedAt" DESC, id DESC
LIMIT 100;
```

Klucz zdarzenia chroni przed powtórnym zapisem przy ponowieniu wysyłki. Przetworzone surowe odczyty są usuwane po 30 dniach przez backend. Własna historia obecności ma osobne tabele.

## Tryb testowy Kantecha

Administrator LDAP może otworzyć `/adminpanel/kantech?dev=1` albo `/adminpanel/kantech?=dev`. Lokalny Compose włącza tryb testowy. W innych środowiskach służy do tego oddzielne ustawienie `KANTECH_DEV_TOOLS=true`.

Wybierz ostatnio odczytany alias lub wpisz go ręcznie. `WI_SYNC1`, `wi-sync-1` i `WISYNC_1` oznaczają to samo przypisanie. Uczestnika można zapisać według nazwy, loginu lub numeru albumu. Dla prowadzącego wybierz osobę z Planu ZUT i podaj jej login w PlanQR. Podgląd pokazuje bieżące i najbliższe zajęcia, a zapisane przypisania można edytować.

W symulacji można wywołać odbicie gotowej karty albo wpisać własny alias. Przykładowe zajęcia pozwalają sprawdzić sekwencję prowadzący → uczestnik → prowadzący także poza godzinami zajęć. Tryb Plan ZUT używa bieżącego planu prowadzącego. Wyniki symulacji są tymczasowe.

## Migracje i testy

- Na pustej bazie uruchom `npm run migrate` przed startem backendu.
- Na odtworzonej bazie sprzed tej zmiany sprawdź schemat względem `202611180001_baseline`. Oznacz ją jako zastosowaną przez `npx prisma migrate resolve --applied 202611180001_baseline` i wykonaj `npm run migrate`. Tabele `tbldydaktyk` i `tbluser` przechowują historyczne dane.
- `npm test` w `backend/` sprawdza rozliczanie odbić, parsowanie XML i strefę czasową. `npm run test:integration` używa `PLANQR_TEST_POSTGRES_URL` do lokalnej bazy `postgres` z prawem tworzenia tymczasowych baz. Test tworzy osobną bazę, uruchamia symulatory LDAP i Kantecha i usuwa po sobie bazę testową.
- Test przeglądarkowy włączają `PLANQR_TEST_PLAYWRIGHT` ze ścieżką do `playwright-core` i `PLANQR_TEST_BROWSER` ze ścieżką do Chrome lub Edge. Wcześniej zbuduj frontend przez `npm run build`.

## Pilotaż fizyczny

1. Po przygotowaniu bazy i migracji ustaw w prywatnym `.env` serwera `KANTECH_MODE=observe`, `KANTECH_DOOR_IDS=49919`, adres SmartService, dane konta z uprawnieniem do odczytu i odrębny `WORKER_SECRET_TOKEN`. Zbuduj obrazy poleceniem `docker compose build backend frontend` i uruchom `docker compose --profile kantech up -d`.
2. Zaloguj się ponownie jako administrator przez LDAP i otwórz `/adminpanel/kantech`. Przy czytniku potwierdź status połączenia i odbicia karty prowadzącego, uczestnika i karty nieprzypisanej. Sprawdź, w którym polu SmartService pojawia się `WISYNC_<numer>`, oraz czy zdarzenia wracają po wznowieniu odczytu. Tryb `observe` wyświetla odbicia bez zapisu obecności.
3. W zakładce **Czytniki** wybierz urządzenie RCP i ustaw role jego czytników. W razie potrzeby przypisz aliasy kart w zakładce **Testy i przypisania**. Po zaliczeniu obserwacji włącz automatyczny zapis obecności i sprawdź otwarcie listy, dopisanie uczestnika, zamknięcie i XLSX.
