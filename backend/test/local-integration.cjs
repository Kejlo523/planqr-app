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
        const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1200, height: 780 } });
        await context.addInitScript((url) => {
            window.__APP_CONFIG__ = { ZUT_PLAN_BASE_URL: url };
        }, simulator);
        const login = await context.request.post(url + '/api/auth/login', { data: { username: 'pilot-admin', password } });
        assert.equal(login.status(), 200);
        const search = await context.request.get(url + '/schedule.php?kind=teacher&query=Prowadzacy');
        assert.equal(search.status(), 200);
        assert.equal((await search.json())[0].id, 'test-teacher');
        const page = await context.newPage();
        await page.goto(url + '/adminpanel/kantech');
        await page.getByRole('heading', { name: 'Kantech na żywo' }).waitFor();
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
        console.log('Browser monitor, LDAP session and XLSX download passed.');
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
    const sql = new Client({ connectionString: adminDb.href });
    const directory = await mkdtemp(join(tmpdir(), 'planqr-integration-'));
    let created = false;
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
            KANTECH_DEV_TOOLS: 'true',
            BACKEND_PUBLIC_URL: api, CORS_ORIGIN: api, DATABASE_URL: database.href,
            JWT_SECRET: secret(), ROOT_ADMIN_LOGIN: 'local-root', ROOT_ADMIN_PASSWORD: secret(),
            LDAP_URL: 'ldap://127.0.0.1:' + ldapPort, LDAP_DN: 'uid=%s,dc=localhost', LDAP_SYNC_ENABLED: 'false',
            ZUT_SCHEDULE_STUDENT_URL: simulator + '/schedule_student.php',
            WORKER_SECRET_TOKEN: secret(), KANTECH_ACTIVE_FROM: at(-86_400),
        };
        run(['node_modules/prisma/build/index.js', 'migrate', 'deploy'], common);
        run(['dist/attendance/configure.js', join(fixtures, 'assignments.json')], common);
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
                KANTECH_DOOR_IDS: '49919,49920', KANTECH_POLL_INTERVAL_MS: '500', KANTECH_REPORT_URL: api + '/internal/kantech',
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
        let headers = await authenticate();
        const live = async () => {
            const response = await request(api + '/api/kantech/events', { headers });
            if (!response.ok) throw new Error('Cannot read monitor');
            return response.json();
        };
        const list = (id, credentials = headers) => request(api + '/api/attendance/list?lesson_id=' + id, { headers: credentials });
        await emit('WISYNC_1', at(-172_800));
        await waitFor('visible observation', async () => (await live()).events.some((event) => event.outcome === 'observed'));
        assert.equal((await list(9001)).status, 404);
        assert.equal((await request(api + '/api/kantech/events', { headers: student })).status, 403);
        assert.equal((await request(api + '/api/kantech/events', { json: {} })).status, 401);
        assert.equal((await request(api + '/internal/kantech', { json: {} })).status, 401);
        const service = { Authorization: 'Bearer ' + common.WORKER_SECRET_TOKEN };
        const root = await authenticate(common.ROOT_ADMIN_LOGIN, common.ROOT_ADMIN_PASSWORD);
        assert.equal((await request(api + '/api/kantech/events', { headers: root })).status, 403);
        assert.equal((await request(api + '/api/kantech/events', { headers: root, json: {} })).status, 403);
        const authenticatedLecturer = await authenticate('lecturer-two');
        assert.equal((await request(api + '/api/kantech/events', { headers: authenticatedLecturer })).status, 403);
        assert.equal((await request(api + '/api/kantech/events', { headers: service, json: {} })).status, 401);
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
        assert.ok((await live()).events.every((item) => !('sourceAlias' in item)));
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
        const simulate = async (alias) => (await request(dev + '/scans', {
            headers, json: { readerId: '49920', alias, source: 'demo' },
        })).json();
        assert.equal((await simulate('WI_SYNC1'))[0].outcome, 'opened');
        const visitor = (await simulate('wi_sync12'))[0];
        assert.equal(visitor.outcome, 'recorded');
        assert.equal(visitor.label, 'Gość testowy');
        assert.equal((await simulate('WISYNC_1'))[0].outcome, 'closed');
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
        assert.ok((await live()).events.some((item) => item.outcome === 'unknown_card' && !item.label.startsWith('WISYNC_')));
        console.log('30-minute boundary, recovery after schedule failure, isolation by room, deduplication and owner access passed.');

        await emit('WISYNC_1', at(-90));
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
        const historical = await waitFor('closed historical occurrence', async () => {
            const response = await list(9000);
            if (response.ok) return response.json();
        });
        assert.equal(historical.status, 'closed');
        assert.equal(historical.closedAt, at(-10_000));
        assert.equal(historical.totalPresent, 1);
        assert.equal((await (await list(9001)).json()).sessionId, opened.sessionId);
        await stop(worker);
        worker = launch('dist/attendance/worker.js', buttons.worker);
        await delay(1_600);
        assert.equal((await (await list(9001)).json()).totalScans, 2);
        console.log('Late scans, early close corrections, automatic close, separate history and worker restart passed.');

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
        await browserSmoke(api, simulator, ldapPassword, directory);

        const tablet = await request(api + '/api/devices', {
            headers, json: { deviceId: randomUUID(), deviceClassroom: 'TEST 201' },
        });
        assert.equal(tablet.status, 201);
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
    } finally {
        await Promise.all([...processes].map(stop));
        if (created) await sql.query('DROP DATABASE ' + name + ' WITH (FORCE)');
        await sql.end();
        await rm(directory, { recursive: true, force: true });
    }
}

main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
});
