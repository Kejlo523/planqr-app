const http = require('node:http');
const { randomUUID } = require('node:crypto');

const formatter = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});
const scans = new Map();
const sessions = new Set();
let scheduleAvailable = true;
let readerAvailable = true;
const clock = Date.now();
let lessons = [{
    teacher: 'test-teacher', id: 9001, title: 'Zajęcia pilotażowe', room: 'TEST 201',
    _building_id: 'TEST', _room_number: '201',
    start: new Date(clock + 5 * 60_000).toISOString(),
    end: new Date(clock + 50 * 60_000).toISOString(),
}];

function send(response, status, document, type = 'application/json') {
    response.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    response.end(type === 'application/json' ? JSON.stringify(document) : document);
}

async function json(request) {
    let body = '';
    for await (const chunk of request) {
        body += chunk;
        if (body.length > 64_000) throw new Error('Payload too large');
    }
    return JSON.parse(body);
}

const routes = async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const query = url.searchParams;
    if (request.method === 'POST') {
        const value = await json(request);
        if (url.pathname === '/test/scans') {
            const reader = String(value.readerId ?? '49919');
            const at = value.at === undefined ? new Date() : new Date(value.at);
            const alias = String(value.alias ?? '').toUpperCase();
            if (!/^\d{1,8}$/.test(reader) || !/^WISYNC_\d{1,8}$/.test(alias) || isNaN(+at)) {
                send(response, 400, { message: 'Pass readerId, WISYNC_<number>, and optional ISO time' });
                return;
            }
            const buffer = scans.get(reader) ?? [];
            const status = value.granted === false ? 'Access denied' : 'Access granted';
            const card = alias.split('_')[1].padStart(4, '0');
            buffer.unshift(formatter.format(at) + ' ' + status + ' 0000:' + card + ' ' + alias);
            scans.set(reader, buffer.slice(0, 100));
            send(response, 201, { alias, reader, at: at.toISOString() });
            return;
        }
        if (url.pathname === '/test/schedule' && Array.isArray(value)) {
            lessons = value;
            send(response, 200, { count: lessons.length });
            return;
        }
        if (url.pathname === '/test/availability') {
            if (typeof value.reader === 'boolean') readerAvailable = value.reader;
            if (typeof value.schedule === 'boolean') scheduleAvailable = value.schedule;
            send(response, 200, { readerAvailable, scheduleAvailable });
            return;
        }
    } else if (request.method === 'GET') {
        if (url.pathname === '/schedule_student.php') {
            if (!scheduleAvailable) {
                send(response, 503, { message: 'Simulated schedule outage' });
                return;
            }
            const teacher = query.get('teacher');
            const room = query.get('room');
            send(response, 200, [[], ...lessons.filter((lesson) => (!teacher || teacher === lesson.teacher)
                && (!room || room === lesson.room || room === lesson._room_number))]);
            return;
        }
        if (url.pathname === '/schedule.php') {
            const search = query.get('query')?.trim().toLocaleLowerCase('pl-PL');
            if (query.get('kind') !== 'teacher' || !search) {
                send(response, 400, { message: 'Required teacher search parameters are missing' });
                return;
            }
            const name = 'Prowadzacy Testowy';
            send(response, 200, name.toLowerCase().includes(search)
                ? [{ id: 'test-teacher', label: name, item: name }] : []);
            return;
        }
        if (url.pathname.startsWith('/SmartService/')) {
            if (!readerAvailable) {
                send(response, 503, { message: 'Simulated reader outage' });
                return;
            }
            if (url.pathname.endsWith('/Login')) {
                const key = randomUUID();
                sessions.add(key);
                send(response, 200, '<Reply><SessionKey>' + key + '</SessionKey></Reply>', 'text/xml');
                return;
            }
            const key = query.get('sdKey');
            if (!sessions.has(key)) {
                send(response, 401, { message: 'SmartService session ended' });
                return;
            }
            if (url.pathname.endsWith('/Logout')) {
                sessions.delete(key);
                send(response, 200, '<Reply/>', 'text/xml');
                return;
            }
            if (url.pathname.endsWith('/LastDoorAccess')) {
                const items = (scans.get(query.get('id')) ?? []).map((value, index) => (
                    '<item><key><string>' + index + '</string></key><value><SmartLinkDataValue><Value>' +
                    value + '</Value></SmartLinkDataValue></value></item>'
                ));
                send(response, 200, '<Reply>' + items.join('') + '</Reply>', 'text/xml');
                return;
            }
        }
    }
    send(response, 404, { message: 'Fixture endpoint not found' });
};

const port = Number(process.env.PORT ?? 18700);
const host = process.env.HOST ?? '127.0.0.1';
if (process.env.LDAP_FIXTURE_PORT) {
    require('./ldap-fixture.cjs')(Number(process.env.LDAP_FIXTURE_PORT), host, process.env.LDAP_FIXTURE_PASSWORD);
}
http.createServer((request, response) => void routes(request, response).catch(() => {
    send(response, 400, { message: 'Invalid fixture request' });
})).listen(port, host, () => console.log('PlanQR simulator ready on port', port));
