const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const { randomBytes, randomUUID } = require('node:crypto');
const { once } = require('node:events');
const { mkdir, mkdtemp, readFile, rm } = require('node:fs/promises');
const { createServer } = require('node:net');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const jwt = require('jsonwebtoken');
const { Client } = require('pg');

const backend = resolve(__dirname, '..');
const fixtures = resolve(backend, '../local');
const processes = new Set();

async function port() {
    const server = createServer().listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address().port;
    await new Promise((done) => server.close(done));
    return address;
}

function launch(path, env, cwd = backend, args = []) {
    const child = spawn(process.execPath, [resolve(backend, path), ...args], {
        cwd, env, windowsHide: true, stdio: ['ignore', 'inherit', 'inherit'],
    });
    processes.add(child);
    child.once('exit', () => processes.delete(child));
    return child;
}

async function stop(child) {
    if (!processes.has(child)) return;
    const exited = once(child, 'exit');
    child.kill();
    await exited;
}

function run(args, env) {
    execFileSync(process.execPath, args, { cwd: backend, env, stdio: 'inherit', windowsHide: true });
}

async function waitFor(label, check, timeout = 12_000) {
    const until = Date.now() + timeout;
    while (Date.now() < until) {
        const value = await check().catch(() => undefined);
        if (value) return value;
        await delay(200);
    }
    throw new Error('Timed out waiting for ' + label);
}

function request(path, { json, method, headers } = {}) {
    return fetch(path, {
        method: method ?? (json === undefined ? 'GET' : 'POST'),
        headers: json === undefined ? headers : { ...headers, 'Content-Type': 'application/json' },
        body: json === undefined ? undefined : JSON.stringify(json),
        signal: AbortSignal.timeout(4_000),
    });
}

async function browserSmoke(api, simulator, password, directory) {
    const playwright = process.env.PLANQR_TEST_PLAYWRIGHT;
    const executablePath = process.env.PLANQR_TEST_BROWSER;
    if (!playwright || !executablePath) return;
    const frontend = resolve(backend, '../frontend');
    const browserPort = await port();
    const url = 'http://127.0.0.1:' + browserPort;
    const preview = launch(join(frontend, 'node_modules/vite/bin/vite.js'), {
        ...process.env, FRONTEND_PUBLIC_URL: url, FRONTEND_DEV_PORT: String(browserPort),
        FRONTEND_CERTS_DIR: join(directory, 'frontend-certs'),
        BACKEND_PUBLIC_URL: api, ZUT_SCHEDULE_URL: simulator + '/schedule.php',
        ZUT_SCHEDULE_STUDENT_URL: simulator + '/schedule_student.php',
    }, frontend, ['preview', '--host', '127.0.0.1', '--strictPort', '--port', String(browserPort)]);
    await waitFor('frontend preview', async () => (await request(url + '/')).ok);
    const browser = await require(playwright).chromium.launch({ executablePath, headless: true });
    try {
        const context = await browser.newContext({ acceptDownloads: true, colorScheme: 'dark', viewport: { width: 1200, height: 780 } });
        await context.addInitScript((url) => {
            window.__APP_CONFIG__ = { ZUT_PLAN_BASE_URL: url };
        }, simulator);
        const page = await context.newPage();
        await page.goto(url + '/');
        assert.equal(await page.getByLabel('Login uczelniany').getAttribute('placeholder'), null);
        await page.getByLabel('Login uczelniany').fill('pilot-admin@zut.edu.pl');
        await page.getByLabel('Hasło').fill(password);
        const loginResponse = page.waitForResponse((response) => response.url() === url + '/api/auth/login');
        await page.getByRole('button', { name: 'Zaloguj', exact: true }).click();
        const login = await loginResponse;
        assert.equal(login.status(), 200);
        assert.equal((await login.json()).login, 'pilot-admin');
        await page.waitForURL(url + '/lecturerPlan');
        const search = await context.request.get(url + '/schedule.php?kind=teacher&query=Prowadzacy');
        assert.equal(search.status(), 200);
        assert.equal((await search.json())[0].id, 'test-teacher');
        await page.goto(url + '/adminpanel');
        const gridBody = page.locator('.admin-devices-grid .ag-body-viewport');
        await gridBody.waitFor({ state: 'attached' });
        const tabletSelection = page.getByRole('checkbox', { name: /^Zaznacz tablet / });
        for (const width of [1920, 1440, 1280, 1024, 390]) {
            await page.setViewportSize({ width, height: 950 });
            assert.ok((await gridBody.boundingBox())?.height >= 64, 'Tablet grid has room for a row at ' + width + 'px');
            await tabletSelection.waitFor();
        }
        await page.setViewportSize({ width: 1920, height: 950 });
        const batchActions = page.locator('.admin-devices-view__selection');
        await batchActions.getByText('Operacje zbiorowe · Zaznaczone: 0').click();
        const apply = batchActions.getByRole('button', { name: 'Ustaw', exact: true }).first();
        assert.ok(await apply.isDisabled());
        await tabletSelection.check();
        await batchActions.getByText('Operacje zbiorowe · Zaznaczone: 1').waitFor();
        assert.ok(await apply.isEnabled());

        const previewTablets = await Promise.all(Array.from({ length: 9 }, async (_, index) => {
            const created = await context.request.post(url + '/api/devices', {
                data: { deviceId: randomUUID(), deviceClassroom: 'TEST ' + (202 + index) },
            });
            assert.equal(created.status(), 201);
            const { id } = await created.json();
            const paired = await context.request.put(url + '/api/devices/' + id, {
                data: { status: 'ACTIVE', lastSeen: new Date(Date.now() - 3_600_000).toISOString() },
            });
            assert.equal(paired.status(), 204);
            return id;
        }));
        await page.goto(url + '/adminpanel?view=tablet-preview');
        const tabletPicker = page.getByRole('combobox', { name: 'Tablet', exact: true });
        await page.waitForURL((target) => target.searchParams.has('deviceId'));
        await tabletPicker.getByRole('option', { name: /^TEST 210 · / }).waitFor({ state: 'attached' });
        assert.equal(await tabletPicker.getByRole('option').count(), 10);
        const lastTablet = String(previewTablets[8]);
        await tabletPicker.selectOption(lastTablet);
        await page.waitForURL((target) => target.searchParams.get('deviceId') === lastTablet);
        await page.reload();
        await tabletPicker.getByRole('option', { name: /^TEST 210 · / }).waitFor({ state: 'attached' });
        assert.equal(await tabletPicker.inputValue(), lastTablet);
        await page.setViewportSize({ width: 390, height: 780 });
        const anotherTablet = String(previewTablets[0]);
        await tabletPicker.selectOption(anotherTablet);
        await page.waitForURL((target) => target.searchParams.get('deviceId') === anotherTablet);
        assert.equal(await tabletPicker.inputValue(), anotherTablet);
        console.log('Tablet preview exposes every paired device and keeps the chosen tablet after reload.');

        await page.setViewportSize({ width: 1200, height: 780 });

        const cardId = '04:51:07:da:00:11';
        const scan = await context.request.post(url + '/api/kantech/events', {
            data: { readerId: '49920', alias: cardId, occurredAt: new Date().toISOString(), granted: false },
        });
        assert.equal(scan.status(), 204);
        await page.getByRole('link', { name: 'Kantech', exact: true }).click();
        await page.getByRole('heading', { name: 'Kantech na żywo' }).waitFor();
        await page.getByRole('cell', { name: cardId, exact: true }).waitFor();
        await page.getByRole('cell', { name: 'Zamknięto listę' }).first().waitFor();
        const screenshots = process.env.PLANQR_TEST_SCREENSHOTS;
        if (screenshots) {
            await page.screenshot({ path: join(screenshots, 'kantech-desktop.png') });
            await page.setViewportSize({ width: 400, height: 780 });
            await page.screenshot({ path: join(screenshots, 'kantech-mobile.png') });
        }
        await page.goto(url + '/attendance/9001');
        await page.getByText('Gość testowy', { exact: true }).waitFor();
        const file = page.waitForEvent('download');
        await page.getByRole('button', { name: 'Pobierz XLSX' }).click();
        const download = await file;
        assert.match(download.suggestedFilename(), /\.xlsx$/);
        const content = await readFile(await download.path());
        assert.equal(content.subarray(0, 2).toString(), 'PK');
        assert.ok(content.includes(Buffer.from('xl/worksheets/sheet1.xml')));
        assert.ok(content.includes(Buffer.from('guest-test')));
        await page.goto(url + '/attendance/9003');
        await page.getByText('Lista otwarta', { exact: true }).waitFor();
        const inProgressFile = page.waitForEvent('download');
        await page.getByRole('button', { name: 'Pobierz XLSX' }).click();
        const inProgressContents = await readFile(await (await inProgressFile).path());
        assert.ok(inProgressContents.includes(Buffer.from('Fixture 9003')));
        await page.goto(url + '/adminpanel/kantech?=dev');
        await page.getByRole('heading', { name: 'Testy Kantecha' }).waitFor();
        await page.getByLabel('Alias z czytnika').fill('wi_sync77');
        await page.getByLabel('Nazwa, login lub numer albumu').fill('123987');
        await page.getByRole('button', { name: 'Zapisz przypisanie' }).click();
        await page.getByRole('button', { name: 'Edytuj WISYNC_77' }).waitFor();
        await page.getByLabel('Typ przypisania').selectOption('lecturer');
        await page.getByLabel('Nazwisko w Planie ZUT').fill('Prowadzacy');
        await page.getByRole('button', { name: 'Szukaj w Planie ZUT' }).click();
        await page.getByRole('button', { name: 'Prowadzacy Testowy', exact: true }).click();
        await page.getByRole('heading', { name: 'Teraz', exact: true }).waitFor();
        await page.getByRole('button', { name: 'WISYNC_1 · Prowadzący' }).click();
        await page.getByText('Otwarto listę', { exact: false }).first().waitFor();
        await page.getByRole('button', { name: 'WISYNC_2 · Student' }).click();
        await page.getByText('Dopisano obecność', { exact: false }).first().waitFor();
        await page.setViewportSize({ width: 400, height: 720 });
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.mouse.move(8, 400);
        await page.mouse.wheel(0, 850);
        await page.waitForFunction(() => window.scrollY > 0);
        await page.getByRole('button', { name: 'Otwórz sekcje panelu' }).click();
        await page.getByRole('link', { name: 'Parowanie kodem QR' }).click();
        const pairing = page.getByRole('dialog', { name: 'Tryb parowania' });
        await pairing.getByRole('button', { name: 'Wyjdź z trybu parowania' }).click();
        await pairing.waitFor({ state: 'hidden' });

        await page.setViewportSize({ width: 1560, height: 810 });
        await page.clock.setFixedTime(new Date('2026-11-18T11:00:00+01:00'));
        const lessonTitle = 'Warsztat danych';
        const lessonDate = '2026-11-20';
        await page.route(/\/api\/schedule\?kind=worker/, (route) => {
            const range = new URL(route.request().url()).searchParams;
            const inRange = lessonDate >= range.get('start').slice(0, 10)
                && lessonDate < range.get('end').slice(0, 10);
            return route.fulfill({ json: inRange ? [{
                id: '357162', title: lessonTitle, room: 'WI WI1- 313',
                start: lessonDate + 'T10:15:00+01:00', end: lessonDate + 'T11:45:00+01:00',
            }] : [] });
        });
        await page.route(/\/api\/attendance\/list\?/, (route) =>
            route.fulfill({ status: 404, json: { message: 'Attendance session not found' } }));
        await page.goto(url + '/lecturerPlan?mode=admin-preview&fullName=Prowadzacy+Testowy');
        await page.getByRole('button', { name: /Warsztat danych/ }).click();
        const lessonHeading = page.getByRole('heading', { name: lessonTitle, exact: true });
        await lessonHeading.waitFor();
        await page.getByRole('button', { name: 'Panel obecności', exact: true }).click();
        const attendance = page.locator('.lesson-attendance');
        await attendance.getByText('Dla tych zajęć nie ma jeszcze sesji obecności.').waitFor();
        await page.setViewportSize({ width: 390, height: 720 });
        await page.locator('.lecturer-console__drawer--attendance').getByText('Lista obecności', { exact: true }).waitFor();
        await attendance.getByRole('button', { name: 'Zamknij panel obecności' }).click();
        await lessonHeading.waitFor();
        await page.getByRole('button', { name: 'Zamknij panel zajęć' }).click();
        await lessonHeading.waitFor({ state: 'hidden' });
        await page.goto(url + '/adminpanel/kantech?view=readers');
        const inventory = page.getByRole('complementary', { name: 'Czytniki w SmartService' });
        const inventoryDoor = (id) => inventory.getByRole('listitem').filter({ hasText: id });
        await inventoryDoor('49919').getByText('Online', { exact: true }).waitFor();
        await inventoryDoor('49888').getByText('Offline', { exact: true }).waitFor();
        await inventoryDoor('49889').getByText('Wyłączony', { exact: true }).waitFor();
        await inventoryDoor('49890').getByText('Brak stanu', { exact: true }).waitFor();
        await page.setViewportSize({ width: 1440, height: 900 });
        const addReaders = page.getByRole('button', { name: 'Dodaj czytniki', exact: true });
        const readerForm = page.getByRole('region', { name: 'Dodaj czytniki' });
        await readerForm.waitFor({ state: 'hidden' });
        await addReaders.click();
        await readerForm.waitFor();
        assert.ok((await inventory.boundingBox()).x > (await readerForm.boundingBox()).x);
        await page.setViewportSize({ width: 390, height: 780 });
        assert.ok((await inventory.boundingBox()).y > (await readerForm.boundingBox()).y);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
        await page.setViewportSize({ width: 1200, height: 780 });
        await page.getByLabel('ID wejścia').fill('49998');
        await page.getByLabel('Nazwa wejścia').fill('Testowe wejście');
        await page.getByLabel('ID wyjścia').fill('49997');
        await page.getByLabel('Nazwa wyjścia').fill('Testowe wyjście');
        await page.getByRole('button', { name: 'Zapisz konfigurację' }).click();
        await page.getByText('Zapisano parę 49998 → 49997.').waitFor();
        await readerForm.waitFor({ state: 'hidden' });
        const pair = page.getByRole('list', { name: 'Zapisane czytniki' }).getByRole('listitem')
            .filter({ hasText: '49998' });
        await pair.getByText('→', { exact: true }).waitFor();
        assert.match(await pair.textContent(), /Wejście.*49998.*→.*Wyjście.*49997/);
        await page.getByRole('button', { name: 'Edytuj parę 49998 i 49997' }).click();
        assert.equal(await page.getByLabel('ID wejścia').inputValue(), '49998');
        await page.getByLabel('Budynek').fill('TEST');
        await page.getByLabel('Sala', { exact: true }).fill('401');
        await page.getByRole('button', { name: 'Zapisz konfigurację' }).click();
        await page.getByText('TEST / 401', { exact: false }).first().waitFor();

        await addReaders.click();
        await page.getByLabel('Jeden czytnik obsługuje wejście i wyjście').check();
        await page.getByLabel('ID wyjścia').waitFor({ state: 'hidden' });
        await page.getByLabel('ID wejścia').fill('49995');
        await page.getByLabel('Nazwa wejścia').fill('Czytnik dwukierunkowy');
        await page.getByRole('button', { name: 'Zapisz konfigurację' }).click();
        await page.getByText('Zapisano czytnik 49995 jako wejście i wyjście.').waitFor();
        page.once('dialog', (dialog) => dialog.accept());
        await page.getByRole('button', { name: 'Usuń czytnik 49995' }).click();
        await page.getByText('Usunięto czytnik 49995.').waitFor();
        page.once('dialog', (dialog) => dialog.accept());
        await page.getByRole('button', { name: 'Usuń czytnik 49998' }).click();
        await page.getByText('Usunięto czytnik 49998.').waitFor();
        await pair.waitFor({ state: 'hidden' });
        page.once('dialog', (dialog) => dialog.accept());
        await page.getByRole('button', { name: 'Usuń czytnik 49997' }).click();
        await page.getByText('Usunięto czytnik 49997.').waitFor();

        await page.setViewportSize({ width: 1366, height: 800 });
        await page.getByRole('link', { name: 'Logi', exact: true }).click();
        await page.getByRole('heading', { name: 'Logi', exact: true }).waitFor();
        const audit = '/api/audit?limit=50';
        const beforeSearch = await waitFor('reader deletion in audit', async () => {
            const { entries } = await (await page.request.get(url + audit)).json();
            return entries[0]?.target === '49997' && entries[0].action === 'Usunięto czytnik' && entries[0].id;
        });
        assert.ok((await page.request.get(url + '/schedule.php?kind=teacher&query=Prowadzacy')).ok());
        const afterSearch = await (await page.request.get(url + audit)).json();
        assert.equal(afterSearch.entries[0].id, beforeSearch);
        await page.getByLabel('Wpisy na stronie').selectOption('25');
        await page.getByLabel('Obszar').selectOption('AUTH');
        await page.getByRole('cell', { name: 'Zalogowano się', exact: true }).first().waitFor();
        await page.setViewportSize({ width: 390, height: 720 });
        assert.ok(await page.getByLabel('Okres przechowywania w dniach').isVisible());
        assert.ok(await page.getByRole('table', { name: 'Dziennik działań w PlanQR' }).isVisible());
        console.log('Browser monitor, LDAP session, XLSX download and audit filters passed.');
    } finally {
        await browser.close();
        await stop(preview);
    }
}

async function main() {
    const adminDb = new URL(process.env.PLANQR_TEST_POSTGRES_URL);
    if (!['127.0.0.1', 'localhost'].includes(adminDb.hostname) || adminDb.pathname !== '/postgres' || adminDb.search) {
        throw new Error('PLANQR_TEST_POSTGRES_URL must point to postgres on the local machine');
    }
    const name = 'planqr_test_' + randomBytes(6).toString('hex');
    const workerRole = name + '_kantech';
    const sql = new Client({ connectionString: adminDb.href });
    const directory = await mkdtemp(join(tmpdir(), 'planqr-integration-'));
    let created = false;
    let workerRoleCreated = false;
    await sql.connect();
    try {
        await sql.query('CREATE DATABASE ' + name);
        created = true;
        const database = new URL(adminDb.href);
        database.pathname = '/' + name;
        const [backendPort, simulatorPort, ldapPort] = await Promise.all([port(), port(), port()]);
        const api = 'http://127.0.0.1:' + backendPort;
        const simulator = 'http://127.0.0.1:' + simulatorPort;
        const secret = () => randomBytes(32).toString('hex');
        const now = Math.floor(Date.now() / 1000) * 1000;
        const at = (seconds) => new Date(now + seconds * 1000).toISOString();
        const common = {
            ...process.env,
            NODE_ENV: 'test', PORT: String(backendPort), BACKEND_BIND_IP: '127.0.0.1',
            DISABLE_HTTPS: 'true', DEV_AUTH_BYPASS: 'false',
            KANTECH_TRANSPORT: 'http',
            KANTECH_DEV_TOOLS: 'true',
            KANTECH_DOOR_IDS: '49919,49920',
            BACKEND_PUBLIC_URL: api, CORS_ORIGIN: api, DATABASE_URL: database.href,
            JWT_SECRET: secret(), ROOT_ADMIN_LOGIN: 'local-root', ROOT_ADMIN_PASSWORD: secret(),
            LDAP_URL: 'ldap://127.0.0.1:' + ldapPort, LDAP_DN: 'uid=%s,dc=localhost', LDAP_SYNC_ENABLED: 'false',
            ZUT_SCHEDULE_STUDENT_URL: simulator + '/schedule_student.php',
            WORKER_SECRET_TOKEN: secret(), KANTECH_ACTIVE_FROM: at(-86_400),
        };
        run(['node_modules/prisma/build/index.js', 'migrate', 'deploy'], common);
        await mkdir(join(directory, 'uploads'));

        const seeded = new Client({ connectionString: database.href });
        await seeded.connect();
        try {
            await seeded.query('INSERT INTO admins (id, username, "updatedAt") VALUES ($1, $2, NOW())',
                ['fixture-admin', 'pilot-admin']);
        } finally {
            await seeded.end();
        }
        const ldapPassword = secret();
        launch(join(fixtures, 'simulator.cjs'), {
            ...process.env, PORT: String(simulatorPort), HOST: '127.0.0.1',
            LDAP_FIXTURE_PORT: String(ldapPort), LDAP_FIXTURE_PASSWORD: ldapPassword,
        });
        await waitFor('fixture server', async () =>
            (await request(simulator + '/schedule.php?kind=teacher&query=Prowadzacy')).ok);
        const emit = async (alias, at, readerId = '49919') =>
            assert.equal((await request(simulator + '/test/scans', { json: { alias, at, readerId } })).status, 201);
        const buttons = {
            worker: {
                ...common, KANTECH_URL: simulator + '/SmartService', KANTECH_USER: 'fixture', KANTECH_PASS: secret(),
                KANTECH_POLL_INTERVAL_MS: '500', KANTECH_REPORT_URL: api + '/internal/kantech',
            },
        };
        const startBackend = (mode) => launch('dist/server.js', { ...common, KANTECH_MODE: mode }, directory);
        const authenticate = async (username = 'pilot-admin', password = ldapPassword) => {
            await waitFor('backend health', async () => (await request(api + '/status')).ok);
            const result = await request(api + '/api/auth/login', {
                json: { username, password },
            });
            assert.equal(result.status, 200);
            return { Cookie: result.headers.get('set-cookie').split(';')[0] };
        };
        const credentials = (login, title) => ({
            Authorization: 'Bearer ' + jwt.sign({ sub: login, title, planqrAccessVersion: 2 }, common.JWT_SECRET, {
                issuer: 'PlanQR_Issuer', audience: 'PlanQR_Audience', expiresIn: '1h',
            }),
        });
        const student = credentials('student-test', 'student');
        const lecturer = credentials('lecturer-two', 'teacher');
        let server = startBackend('observe');
        let worker = launch('dist/attendance/worker.js', buttons.worker);
        let headers = await authenticate(' pilot-admin @zut.edu.pl ');
        assert.equal((await request(api + '/api/auth/login', {
            json: { username: '@zut.edu.pl', password: ldapPassword },
        })).status, 400);
        const readersApi = api + '/api/kantech/readers';
        const workerReaders = api + '/internal/kantech/readers';
        const service = { Authorization: 'Bearer ' + common.WORKER_SECRET_TOKEN };
        assert.equal((await request(readersApi)).status, 401);
        assert.equal((await request(readersApi, { headers: lecturer })).status, 403);
        assert.equal((await request(workerReaders)).status, 401);
        assert.deepEqual((await (await request(workerReaders, { headers: service })).json()).readerIds, ['49919', '49920']);
        const imported = (await (await request(readersApi, { headers })).json()).readers;
        assert.equal(imported.length, 2);
        assert.ok(imported.every(({ roomNumber }) => !roomNumber));
        const inventoryApi = readersApi + '/inventory';
        const inventoryIngress = api + '/internal/kantech/inventory';
        assert.equal((await request(inventoryApi)).status, 401);
        assert.equal((await request(inventoryApi, { headers: lecturer })).status, 403);
        assert.equal((await request(inventoryIngress, { headers, json: [] })).status, 401);
        assert.equal((await request(inventoryIngress, { headers: service, json: [{ id: '49888', state: 'locked' }] })).status, 400);
        const inventory = await waitFor('SmartService inventory over HTTP', async () => {
            const response = await request(inventoryApi, { headers });
            const snapshot = response.ok && await response.json();
            return snapshot?.checkedAt && snapshot;
        });
        assert.deepEqual(inventory.readers.find(({ id }) => id === '49888'), {
            id: '49888', label: 'Czytnik zapasowy', state: 'offline',
        });
        run(['dist/attendance/configure.js', join(fixtures, 'assignments.json')], common);
        const live = async () => {
            const response = await request(api + '/api/kantech/events', { headers });
            if (!response.ok) throw new Error('Cannot read monitor');
            return response.json();
        };
        const list = (id, credentials = headers) => request(api + '/api/attendance/list?lesson_id=' + id, { headers: credentials });
        await emit('WISYNC_1', at(-172_800));
        await waitFor('visible observation', async () => (await live()).events.some((event) => event.outcome === 'observed'));
        assert.equal((await list(9001)).status, 404);
        assert.equal((await request(api + '/api/kantech/events')).status, 401);
        assert.equal((await request(api + '/api/kantech/events', { headers: student })).status, 403);
        assert.equal((await request(api + '/api/kantech/events', { json: {} })).status, 401);
        assert.equal((await request(api + '/internal/kantech', { json: {} })).status, 401);
        const root = await authenticate(common.ROOT_ADMIN_LOGIN, common.ROOT_ADMIN_PASSWORD);
        assert.equal((await request(api + '/api/kantech/events', { headers: root })).status, 403);
        assert.equal((await request(api + '/api/kantech/events', { headers: root, json: {} })).status, 403);
        const authenticatedLecturer = await authenticate('lecturer-two');
        assert.equal((await request(api + '/api/kantech/events', { headers: authenticatedLecturer })).status, 403);
        assert.equal((await request(api + '/api/kantech/events', { headers: service, json: {} })).status, 401);
        const newReader = { id: '49999', label: 'Czytnik dodany ręcznie' };
        assert.equal((await request(readersApi, { headers: authenticatedLecturer, json: newReader })).status, 403);
        assert.equal((await request(readersApi, { headers, json: { ...newReader, buildingId: 'WI1' } })).status, 400);
        assert.equal((await request(readersApi, { headers, json: newReader })).status, 200);
        await waitFor('new reader polled without restarting the worker', async () =>
            (await live()).readers.some(({ id, state }) => id === newReader.id && state === 'connected'));
        assert.equal((await request(readersApi + '/' + newReader.id, { headers, method: 'DELETE' })).status, 204);
        assert.ok(!(await live()).readers.some(({ id }) => id === newReader.id));
        const bearer = { Authorization: 'Bearer ' + headers.Cookie.slice('jwt='.length) };
        assert.equal((await request(api + '/api/kantech/events', {
            headers: bearer, json: { readerId: '49920', alias: 'WISYNC_2', occurredAt: at(-100), granted: true },
        })).status, 204);
        const filtered = await (await request(api + '/api/kantech/events?readerId=49920&limit=1', { headers })).json();
        assert.equal(filtered.events.length, 1);
        assert.equal(filtered.events[0].readerId, '49920');
        const dev = api + '/api/kantech/dev';
        assert.equal((await request(dev)).status, 401);
        assert.equal((await request(dev, { headers: authenticatedLecturer })).status, 403);
        assert.equal((await request(api + '/api/kantech/events', {
            headers, json: { readerId: '49920', alias: 'wi_sync12', occurredAt: at(-95), granted: true },
        })).status, 204);
        const observed = await (await request(dev, { headers })).json();
        assert.ok(observed.observed.some((item) => item.alias === 'wi_sync12' && item.canonicalAlias === 'WISYNC_12'));
        const recentEvents = (await live()).events;
        assert.ok(recentEvents.some((item) => item.label === 'wi_sync12'));
        assert.ok(recentEvents.every((item) => !('sourceAlias' in item)));
        const mapping = await request(dev + '/cards', {
            headers, json: { alias: 'wi_sync12', role: 'participant', target: '654321' },
        });
        assert.equal(mapping.status, 200);
        assert.equal((await mapping.json()).album, '654321');
        const edit = await request(dev + '/cards', {
            headers, json: { alias: 'WISYNC_12', role: 'participant', target: 'fixture-visitor', name: 'Gość testowy' },
        });
        assert.equal(edit.status, 200);
        assert.equal((await edit.json()).name, 'Gość testowy');
        const simulate = async (alias, readerId = '49920') => (await request(dev + '/scans', {
            headers, json: { readerId, alias, source: 'demo' },
        })).json();
        assert.equal((await simulate('WI_SYNC1'))[0].outcome, 'opened');
        const visitor = (await simulate('wi_sync12'))[0];
        assert.equal(visitor.outcome, 'recorded');
        assert.equal(visitor.label, 'Gość testowy');
        assert.equal((await simulate('WISYNC_1'))[0].outcome, 'repeat_tap');
        assert.equal((await simulate('WISYNC_1', '49922'))[0].outcome, 'closed');
        assert.equal((await list('demo')).status, 404);
        const plan = await (await request(dev + '/schedule?teacherId=test-teacher', { headers })).json();
        assert.ok([...plan.current, ...plan.upcoming].some((item) => item.id === '9001'));
        assert.equal((await request(dev + '/scans', { headers, method: 'DELETE' })).status, 204);
        assert.equal((await (await request(dev, { headers })).json()).simulated.length, 0);
        console.log('Observation mode, real login, admin-only monitor and worker authentication passed.');
        await Promise.all([stop(server), stop(worker)]);

        const event = (id, start, end, roomNumber = '201') => ({
            teacher: 'test-teacher', id, title: 'Fixture ' + id, room: 'TEST ' + roomNumber,
            _building_id: 'TEST', _room_number: roomNumber, start: at(start), end: at(end),
        });
        assert.ok((await request(simulator + '/test/schedule', {
            json: [event(9000, -10_800, -10_000), event(9001, -600, 1_800), event(9002, 300, 2_400, '202'),
                event(9003, 600, 2_700, '202')],
        })).ok);
        await request(simulator + '/test/availability', { json: { schedule: false } });
        server = startBackend('attendance');
        worker = launch('dist/attendance/worker.js', buttons.worker);
        headers = await authenticate();
        await emit('WISYNC_1', at(-2_401));
        await emit('WISYNC_1', at(-2_400));
        await emit('WISYNC_2', at(-400));
        await emit('WISYNC_2', at(-400));
        await emit('WISYNC_3', at(-60));
        await emit('WISYNC_2', at(-1_900), '49920');
        await emit('WISYNC_999', at(-50));
        await waitFor('queued lookup', async () => (await live()).events.some((item) => item.outcome === 'pending'));
        assert.equal((await list(9001)).status, 404);
        await request(simulator + '/test/availability', { json: { schedule: true } });
        const opened = await waitFor('recovered schedule and membership', async () => {
            const response = await list(9001);
            if (!response.ok) return;
            const value = await response.json();
            return value.totalPresent === 2 ? value : undefined;
        }, 25_000);
        assert.equal(opened.status, 'open');
        assert.equal(opened.openedAt, at(-2_400));
        assert.equal(opened.totalScans, 2);
        assert.equal((await list(9001, lecturer)).status, 404);
        assert.equal((await list(9001, student)).status, 403);
        assert.equal((await request(api + '/api/attendance/sessions/' + opened.sessionId + '/close', {
            json: {}, headers: lecturer,
        })).status, 404);
        assert.equal((await request(api + '/api/attendance/sessions/' + opened.sessionId + '/close', {
            json: {}, headers,
        })).status, 409);
        assert.ok((await live()).events.some((item) => item.outcome === 'unknown_card' && item.label === 'WISYNC_999'));
        console.log('30-minute boundary, recovery after schedule failure, isolation by room, deduplication and owner access passed.');

        await emit('WISYNC_1', at(-120));
        await emit('WISYNC_1', at(-110), '49922');
        await emit('WISYNC_2', at(-100), '49921');
        await waitFor('wrong exit and student exit leave the list open', async () => (await live()).events.some(
            (item) => item.readerId === '49921' && item.label === 'WISYNC_2' && item.outcome === 'exit_ignored'));
        assert.equal((await (await list(9001)).json()).status, 'open');
        await emit('WISYNC_1', at(-90), '49921');
        await waitFor('late closing tap corrects membership', async () => {
            const value = await (await list(9001)).json();
            return value.status === 'closed' && value.totalPresent === 1;
        });
        await emit('WISYNC_3', at(-200));
        await waitFor('late participant restored within window', async () => {
            const value = await (await list(9001)).json();
            return value.status === 'closed' && value.totalPresent === 2 && value.students.some((member) => member.username === 'guest-test');
        });
        await emit('WISYNC_1', at(-10_790));
        await emit('WISYNC_2', at(-10_775));
        await emit('WISYNC_1', at(-10_000), '49921');
        const historical = await waitFor('closed historical occurrence', async () => {
            const response = await list(9000);
            if (response.ok) {
                const value = await response.json();
                if (value.status === 'closed') return value;
            }
        });
        assert.equal(historical.status, 'closed');
        assert.equal(historical.closedAt, at(-10_000));
        assert.equal(historical.totalPresent, 1);
        assert.equal((await (await list(9001)).json()).sessionId, opened.sessionId);
        await stop(worker);
        worker = launch('dist/attendance/worker.js', buttons.worker);
        await delay(1_600);
        assert.equal((await (await list(9001)).json()).totalScans, 2);
        console.log('Late scans, paired-reader close, separate history and worker restart passed.');

        await emit('WISYNC_1', at(-70), '49920');
        await emit('WISYNC_3', at(-40), '49920');
        const pending = await waitFor('ambiguous choices', async () => {
            const values = await (await request(api + '/api/attendance/pending', { headers })).json();
            return values.find((item) => item.choices.length === 2);
        });
        const key = pending.choices.find((item) => item.id === '9003').key;
        const choose = '/api/attendance/pending/' + pending.id + '/choose';
        assert.equal((await request(api + choose, { headers: lecturer, json: { key } })).status, 404);
        assert.equal((await request(api + choose, { headers, json: { key } })).status, 204);
        const chosen = await (await list(9003)).json();
        assert.equal(chosen.totalPresent, 1);
        assert.equal((await list(9002)).status, 404);
        console.log('Lecturer choice and replay of buffered participants passed.');

        const tablet = await request(api + '/api/devices', {
            headers, json: { deviceId: randomUUID(), deviceClassroom: 'TEST 201' },
        });
        assert.equal(tablet.status, 201);
        const { id: tabletId } = await tablet.json();
        assert.equal((await request(api + '/api/devices/' + tabletId, {
            headers, method: 'PUT', json: { status: 'ACTIVE' },
        })).status, 204);
        await browserSmoke(api, simulator, ldapPassword, directory);
        await emit('WISYNC_1', at(-25), '49922');
        await waitFor('close chosen lesson through its exit', async () => (await (await list(9003)).json()).status === 'closed');
        const count = await (await request(api + '/status')).json();
        assert.ok(count.total >= 1);
        const upload = await request(api + '/api/devices/priority-messages/upload', {
            headers, json: {
                fileName: 'fixture.png', mimeType: 'image/png',
                contentBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==',
            },
        });
        assert.equal(upload.status, 201);
        const file = await upload.json();
        assert.ok((await request(api + file.imageUrl)).ok);
        console.log('Tablet and upload regression checks passed.');

        const audit = api + '/api/audit';
        const retention = audit + '/retention';
        const events = async (query = '') => {
            const response = await request(audit + query, { headers });
            assert.equal(response.status, 200);
            return response.json();
        };
        assert.equal((await request(audit)).status, 401);
        assert.equal((await request(audit, { headers: authenticatedLecturer })).status, 403);
        assert.equal((await request(retention, { method: 'PUT', json: { days: 7 }, headers: authenticatedLecturer })).status, 403);
        assert.equal((await request(audit + '?limit=201', { headers })).status, 400);
        assert.equal((await request(retention, { method: 'PUT', json: { days: 0 }, headers })).status, 400);
        await waitFor('tablet creation in audit', async () => (await events('?category=TABLETS')).entries.some(
            ({ actor, action, target }) => actor === 'pilot-admin' && action === 'Dodano tablet' && target === 'TEST 201'));
        const first = await events('?limit=1');
        assert.equal(first.retentionDays, 30);
        assert.equal(first.entries.length, 1);
        assert.equal(first.nextBefore, first.entries[0].id);
        const older = await events('?limit=1&before=' + first.nextBefore);
        assert.ok(older.entries[0].id < first.entries[0].id);
        assert.ok((await events('?category=AUTH&query=PILOT-ADMIN')).entries.some(({ action }) => action === 'Zalogowano się'));
        assert.deepEqual((await events('?query=%25')).entries, []);

        assert.equal((await request(api + '/api/auth/logout', { method: 'POST', headers: authenticatedLecturer })).status, 200);
        const beforeScan = await waitFor('logout in audit', async () => {
            const { entries } = await events('?limit=1');
            return entries[0]?.actor === 'lecturer-two' && entries[0].action === 'Wylogowano się' && entries[0].id;
        });
        await emit('WISYNC_2', at(-172_799), '49920');
        await waitFor('test card scan in Kantech only', async () => (await live()).events.some(
            ({ readerId, occurredAt }) => readerId === '49920' && new Date(occurredAt).toISOString() === at(-172_799)));
        assert.equal((await events('?limit=1')).entries[0].id, beforeScan);

        const auditSql = new Client({ connectionString: database.href });
        await auditSql.connect();
        try {
            await auditSql.query(`INSERT INTO "AuditEvent" ("occurredAt", category, actor, action)
                VALUES (NOW() - INTERVAL '10 days', 'ADMIN', 'fixture', 'aged fixture')`);
            assert.equal((await events('?query=aged+fixture')).entries.length, 1);
            const saved = await request(retention, { method: 'PUT', headers, json: { days: 7 } });
            assert.equal(saved.status, 200);
            assert.deepEqual(await saved.json(), { retentionDays: 7, removed: 1 });
            const retained = await auditSql.query('SELECT id FROM "AuditEvent" WHERE actor = $1', ['fixture']);
            assert.equal(retained.rowCount, 0);
            assert.ok((await events('?category=ADMIN')).entries.some(({ action, target }) =>
                action === 'Zmieniono okres przechowywania logów' && target === '30 → 7 dni'));
        } finally {
            await auditSql.end();
        }
        console.log('Audit access, useful events, pagination, scan exclusion and automatic retention passed.');

        await Promise.all([stop(server), stop(worker)]);
        const workerPassword = secret();
        // The role name and password contain only generated hexadecimal characters and fixed prefixes.
        await sql.query(`CREATE ROLE ${workerRole} LOGIN PASSWORD '${workerPassword}'`);
        workerRoleCreated = true;
        const directUrl = new URL(database.href);
        directUrl.username = workerRole;
        directUrl.password = workerPassword;
        const readingsSql = new Client({ connectionString: database.href });
        await readingsSql.connect();
        try {
            await readingsSql.query(`
                GRANT USAGE ON SCHEMA public TO ${workerRole};
                GRANT SELECT (id) ON "AttendanceReader" TO ${workerRole};
                GRANT INSERT ON "KantechEvent" TO ${workerRole};
                GRANT SELECT, INSERT, UPDATE ON "KantechReaderStatus" TO ${workerRole};
                GRANT SELECT, INSERT, UPDATE ON "KantechInventory" TO ${workerRole};
                GRANT SELECT ON "KantechCaptureSettings" TO ${workerRole};
            `);
            await readingsSql.query('DELETE FROM "KantechInventory"');
            await readingsSql.query(`INSERT INTO ldap_users (username, display_name, given_name, surname, title)
                VALUES ($1, $2, $3, $4, 'teacher')`, ['alandz', 'Łądź Alicja', 'Alicja', 'Łądź']);
            assert.ok((await request(simulator + '/test/schedule', {
                json: [
                    { ...event(9100, -30, 2_100), teacher: 'test-accented', group_name: 'L7' },
                    { ...event(9200, -20, 2_100, '202'), teacher: 'Żółć Jan', imie: 'Jan', nazwisko: 'Żółć' },
                ],
            })).ok);
            await emit('alandz@zut.edu.pl', at(-12));
            await emit('s054321', at(-10));
            await emit('S054321', at(-5));
            await emit('n54321', at(-4));
            await emit('jzolc@wi.zut.edu.pl', at(-11), '49920');
            await emit('s23465', at(-9), '49920');
            const unassignedAlias = 'WISYNC_8722';
            await emit(unassignedAlias, at(-8));
            const launchDirectWorker = () => launch('dist/attendance/worker.js', {
                ...buttons.worker, KANTECH_TRANSPORT: 'postgres', KANTECH_MODE: 'attendance',
                KANTECH_DATABASE_URL: directUrl.href, KANTECH_REPORT_URL: '', WORKER_SECRET_TOKEN: '', DATABASE_URL: '',
            });
            const rawReadings = () => readingsSql.query('SELECT id, outcome, "captureMode" FROM "KantechReadings" WHERE alias = $1',
                [unassignedAlias]);
            worker = launchDirectWorker();
            const directInventory = await waitFor('SmartService inventory over SQL with PlanQR API stopped', async () => {
                const { rows } = await readingsSql.query('SELECT readers FROM "KantechInventory" WHERE id = 1');
                return rows[0]?.readers;
            });
            assert.ok(directInventory.some(({ id, state }) => id === '49888' && state === 'offline'));
            const raw = await waitFor('raw SQL reading with PlanQR API stopped', async () => (await rawReadings()).rows[0]);
            assert.equal(raw.outcome, 'received');
            assert.equal(raw.captureMode, 'attendance');
            const checked = await readingsSql.query('SELECT "checkedAt" FROM "KantechReaderStatus" WHERE "readerId" = $1', ['49919']);
            const beforeWorkerRestart = checked.rows[0].checkedAt;
            await stop(worker);
            worker = launchDirectWorker();
            await waitFor('DB worker replay and new heartbeat', async () => {
                const { rows } = await readingsSql.query('SELECT "checkedAt" FROM "KantechReaderStatus" WHERE "readerId" = $1', ['49919']);
                return rows[0]?.checkedAt > beforeWorkerRestart;
            });
            assert.equal((await rawReadings()).rowCount, 1);

            server = startBackend('attendance');
            headers = await authenticate();
            const ownerHeaders = credentials('alandz', 'teacher');
            const session = await waitFor('queued attendance for accented lecturer after backend restart', async () => {
                const response = await list(9100, ownerHeaders);
                if (!response.ok) return;
                const value = await response.json();
                if (value.totalPresent === 1) return value;
            });
            assert.equal(session.group, 'L7');
            assert.equal(session.room, 'TEST 201');
            assert.equal(session.lecturerDisplayName, 'Łądź Alicja');
            assert.equal(session.students[0].username, 's054321');
            assert.equal(session.students[0].albumNumber, '054321');
            assert.equal(session.totalScans, 1);
            const preview = api + '/api/attendance/list?lesson_id=9100&teacher=' + encodeURIComponent('Łądź Alicja');
            assert.equal((await request(preview, { headers })).status, 200);
            assert.equal((await request(preview, { headers: lecturer })).status, 403);
            assert.equal((await request(readersApi + '/49921', { method: 'DELETE', headers })).status, 409);
            const fallbackHeaders = credentials('jzolc', 'teacher');
            const fallback = await waitFor('room timetable resolves Żółć without a cached LDAP profile', async () => {
                const response = await list(9200, fallbackHeaders);
                if (!response.ok) return;
                const value = await response.json();
                if (value.totalPresent === 1) return value;
            });
            assert.equal(fallback.lecturerDisplayName, 'Żółć Jan');
            assert.equal(fallback.students[0].username, 's23465');
            await emit('alandz', at(-3), '49921');
            await emit('jzolc', at(-2), '49922');
            await waitFor('lecturer login closes the list at its paired exit', async () =>
                (await (await list(9100, ownerHeaders)).json()).status === 'closed');
            await waitFor('close the second paired room', async () =>
                (await (await list(9200, fallbackHeaders)).json()).status === 'closed');
            const classified = (await rawReadings()).rows[0];
            assert.equal(classified.outcome, 'unknown_card');
            assert.ok((await live()).events.some(({ key, label, outcome }) =>
                key === raw.id && label === unassignedAlias && outcome === classified.outcome));
            assert.ok((await live()).events.some(({ label, outcome }) => label === 'n54321' && outcome === 'unknown_card'));
        } finally {
            await readingsSql.end();
        }
        console.log('Restricted PostgreSQL worker, SQL readings during API downtime, deduplication and attendance recovery passed.');

        const singleReader = { id: '49996', label: 'TEST 403' };
        const setup = { entry: singleReader, buildingId: 'TEST', roomNumber: '403' };
        const setupUrl = readersApi + '/setup';
        assert.equal((await request(setupUrl, { headers, json: { ...setup, exit: singleReader } })).status, 400);
        assert.equal((await request(setupUrl, {
            headers, json: { ...setup, exit: { id: '49921', label: 'Istniejące wyjście' } },
        })).status, 409);
        assert.ok(!(await (await request(readersApi, { headers })).json()).readers.some(({ id }) => id === singleReader.id));
        const single = await request(setupUrl, { headers, json: { ...setup, exit: null } });
        assert.equal(single.status, 201);
        assert.equal((await single.json()).singleReader, true);
        assert.ok((await request(simulator + '/test/schedule', { json: [event(9300, -300, 2_100, '403')] })).ok);
        await emit('WISYNC_1', at(-100), singleReader.id);
        await emit('s054321', at(-95), singleReader.id);
        await emit('WISYNC_1', at(-41), singleReader.id);
        await waitFor('single reader refuses to close after 59 seconds', async () =>
            (await live()).events.some(({ readerId, outcome }) => readerId === singleReader.id && outcome === 'close_too_soon'));
        const singleList = await (await list(9300)).json();
        assert.equal(singleList.status, 'open');
        assert.equal(singleList.exitReaderId, singleReader.id);
        assert.equal(singleList.totalPresent, 1);
        await emit('WISYNC_1', at(-40), singleReader.id);
        const singleClosed = await waitFor('single reader closes at 60 seconds', async () => {
            const snapshot = await (await list(9300)).json();
            return snapshot.status === 'closed' ? snapshot : undefined;
        });
        assert.equal(singleClosed.closedAt, at(-40));
        assert.equal(singleClosed.students[0].username, 's054321');
        assert.equal(singleClosed.students[0].albumNumber, '054321');
        console.log('Atomic reader setup and single-reader closing threshold passed.');

        await stop(server);
        server = startBackend('observe');
        headers = await authenticate();
        const modeUrl = api + '/api/kantech/events/mode';
        const changeMode = (mode, authorized = headers) => request(modeUrl, { headers: authorized, json: { mode } });
        assert.equal((await live()).mode, 'observe');
        assert.equal((await changeMode('attendance', {})).status, 401);
        assert.equal((await changeMode('attendance', lecturer)).status, 403);
        assert.equal((await changeMode('off')).status, 400);
        const enabled = await changeMode('attendance');
        assert.equal(enabled.status, 200);
        const { activeFrom } = await enabled.json();
        assert.equal((await (await changeMode('attendance')).json()).activeFrom, activeFrom);
        assert.equal((await live()).mode, 'attendance');
        const cutover = Date.parse(activeFrom);
        const aroundSwitch = (offset) => new Date(cutover + offset).toISOString();
        assert.equal((await request(setupUrl, { headers, json: {
            entry: { id: '49919', label: 'Wejście 129' }, exit: { id: '49921', label: 'Wyjście 129' },
            buildingId: 'W1', roomNumber: '129', edit: true,
        } })).status, 200);
        const fixtureRoom = {
            ...event(9400, -300, 1_800, '129'), start: aroundSwitch(-60_000), end: aroundSwitch(1_800_000),
            _building_id: 'WI_WI1', room: 'WI WI1- 129',
        };
        assert.ok((await request(simulator + '/test/schedule', {
            json: [fixtureRoom,
                { ...fixtureRoom, id: 9401, _building_id: 'WI_WI2', room: 'WI WI2- 129' },
                { ...fixtureRoom, id: 9402, teacher: 'Nowak Jan', imie: 'Jan', nazwisko: 'Nowak' }],
        })).ok);
        await emit('s94001', aroundSwitch(-2_000));
        await emit('dnowak@zut.edu.pl', aroundSwitch(1_000));
        await emit('WISYNC_1', aroundSwitch(2_000));
        await emit('s94002', aroundSwitch(3_000));
        await waitFor('dynamic mode through PostgreSQL while backend started in observe', async () => {
            const response = await list(9400);
            return response.ok && (await response.json()).students.some(({ username }) => username === 's94002');
        });
        assert.equal((await list(9401)).status, 404);
        assert.ok((await live()).events.some(({ label, outcome }) => label === 's94001' && outcome === 'outside_cutover'));
        await waitFor('campus login does not match another lecturer with the same surname', async () =>
            (await live()).events.some(({ label, outcome }) => label === 'dnowak@zut.edu.pl' && outcome === 'no_match'));
        const submitReport = (alias, offset, readerId) => request(api + '/internal/kantech', {
            headers: service, json: { alias, readerId, granted: true, occurredAt: aroundSwitch(offset) },
        });
        assert.equal((await submitReport('WISYNC_1', 4_000, '49921')).status, 204);
        await waitFor('HTTP worker report closes the list in dynamic attendance mode', async () =>
            (await (await list(9400)).json()).status === 'closed');
        assert.deepEqual(await (await changeMode('observe')).json(), { mode: 'observe', activeFrom: null });
        assert.equal((await submitReport('s94003', 5_000, '49919')).status, 204);
        await waitFor('readings return to observation', async () =>
            (await live()).events.some(({ label, outcome }) => label === 's94003' && outcome === 'observed'));
        assert.equal((await live()).mode, 'observe');
        console.log('LDAP mode switch, capture cutover, and HTTP and PostgreSQL reports passed without a restart.');

        for (const id of ['49919', '49920', '49921', '49922', singleReader.id]) {
            assert.equal((await request(readersApi + '/' + id, { headers, method: 'DELETE' })).status, 204);
        }
        await stop(server);
        server = startBackend('attendance');
        headers = await authenticate();
        assert.equal((await live()).mode, 'observe');
        assert.deepEqual((await (await request(workerReaders, { headers: service })).json()).readerIds, []);
        assert.equal((await list(9001)).status, 200);
        assert.equal((await events('?limit=1')).retentionDays, 7);
        console.log('Reader changes reach the worker, deletions survive restart and attendance history remains available.');
    } finally {
        await Promise.all([...processes].map(stop));
        if (created) await sql.query('DROP DATABASE ' + name + ' WITH (FORCE)');
        if (workerRoleCreated) await sql.query('DROP ROLE ' + workerRole);
        await sql.end();
        await rm(directory, { recursive: true, force: true });
    }
}

main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
});
