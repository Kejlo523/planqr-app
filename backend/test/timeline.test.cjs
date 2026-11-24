const assert = require('node:assert/strict');
const test = require('node:test');
const { createServer } = require('node:http');
const { buildTimeline } = require('../dist/attendance/timeline');
const { parseReaderSnapshot, parseSmartServiceDoors, parseSmartServiceDoorState, SmartService } = require('../dist/attendance/smartService');
const { parseCampusTime } = require('../dist/attendance/scheduleTime');
const { cardAliasKeys, normalizeCardAlias, normalizeCardLogin } = require('../dist/attendance/cardAlias');
const { attendanceIdentity } = require('../dist/attendance/identity');

const start = '2026-11-18T10:00:00.000Z';
const end = '2026-11-18T11:00:00.000Z';
const lesson = { key: 'first', id: '42', title: 'Test', start, end };
const scan = (id, time, login, candidates = [], selectedKey = null) => ({
    id, readerId: '49919', roomKey: 'test-201', roomLabel: '201', alias: login, login, name: login,
    album: null, scheduleId: login === 'lecturer' ? '123' : null,
    occurredAt: new Date(time), candidates, selectedKey, resolution: candidates.length ? 'matched' : 'no_match',
});
const time = (value) => '2026-11-18T' + value + '.000Z';

test('campus card email aliases keep explicit bindings and resolve to known login forms', () => {
    assert.deepEqual(cardAliasKeys(' TestLecturer@wi.zut.edu.pl '), ['TESTLECTURER@WI.ZUT.EDU.PL', 'TESTLECTURER']);
    assert.equal(normalizeCardLogin(' Dnowak@ZUT.edu.pl '), 'dnowak');
    assert.equal(attendanceIdentity('S054321@zut.edu.pl')?.album, '054321');
    assert.equal(attendanceIdentity('testlecturer@other.example'), null);
    assert.equal(attendanceIdentity('testlecturer@fakezut.edu.pl'), null);
});

test('opens at the 30 minute boundary, closes once and retains the first participant tap', () => {
    const result = buildTimeline([
        scan('early', time('09:29:59'), 'lecturer', [lesson]),
        scan('open', time('09:30:00'), 'lecturer', [lesson]),
        scan('one', time('09:30:10'), 'guest'),
        scan('two', time('09:30:15'), 'guest'),
        scan('close', time('09:31:00'), 'lecturer', [lesson]),
        scan('extra', time('09:31:10'), 'lecturer', [lesson]),
        scan('late-outside', time('09:31:15'), 'outsider'),
    ], new Map());
    assert.equal(result.sessions.size, 1);
    const session = [...result.sessions.values()][0];
    assert.equal(session.closesAt.toISOString(), time('09:31:00'));
    assert.equal(session.members.get('guest').firstAt.toISOString(), time('09:30:10'));
    assert.equal(session.members.get('guest').count, 2);
    assert.equal(result.outcomes.get('early'), 'no_match');
    assert.equal(result.outcomes.get('extra'), 'already_closed');
    assert.equal(result.outcomes.get('late-outside'), 'no_session');
});

test('an ambiguous lesson starts only after a choice and recomputes buffered participants', () => {
    const choices = [lesson, { ...lesson, id: '43', key: 'second' }];
    const participant = scan('here', time('10:00:10'), 'worker');
    const pending = buildTimeline([scan('open', start, 'lecturer', choices), participant], new Map());
    const selected = buildTimeline([scan('open', start, 'lecturer', choices, 'second'), participant], new Map());
    assert.equal(pending.sessions.size, 0);
    assert.equal(pending.outcomes.get('open'), 'choose_lesson');
    const actual = [...selected.sessions.values()][0];
    assert.equal(actual.lesson.id, '43');
    assert.equal(actual.members.size, 1);
    assert.equal(actual.closesAt.toISOString(), end);
});

test('paired attendance uses the opening reader, keeps one row and closes only at the assigned exit', () => {
    const tap = (id, at, login, readerId = '49919', readerDirection = 'ENTRY') => ({
        ...scan(id, time(at), login, login === 'lecturer' ? [lesson] : []),
        readerId, readerDirection, exitReaderId: '49921',
    });
    const taps = [
        tap('exit-first', '10:00:00', 'lecturer', '49921', 'EXIT'),
        tap('open', '10:00:01', 'lecturer'),
        tap('student', '10:00:03', 'n57796'),
        tap('student-repeats', '10:00:10', 'n57796'),
        tap('other-entry', '10:01:00', 'n45678', '49920'),
        tap('student-exit', '10:02:00', 'n57796', '49921', 'EXIT'),
        tap('lecturer-entry', '10:03:00', 'lecturer'),
        tap('wrong-exit', '10:04:00', 'lecturer', '49999', 'EXIT'),
    ];
    const open = buildTimeline(taps, new Map());
    const first = [...open.sessions.values()][0];
    assert.equal(first.closesAt, null);
    assert.equal(first.members.size, 1);
    assert.equal(first.members.get('n57796').count, 1);
    assert.equal(first.members.get('n57796').lastAt.toISOString(), time('10:00:03'));
    assert.equal(open.outcomes.get('other-entry'), 'wrong_entry_reader');
    assert.equal(open.outcomes.get('student-exit'), 'exit_ignored');
    assert.equal(open.outcomes.get('lecturer-entry'), 'repeat_tap');
    const closed = buildTimeline([...taps, tap('close', '11:05:00', 'lecturer', '49921', 'EXIT')], new Map());
    assert.equal([...closed.sessions.values()][0].closesAt.toISOString(), time('11:05:00'));
    assert.equal(closed.outcomes.get('close'), 'closed');
});

test('one reader closes only for the lecturer at least 60 seconds after opening', () => {
    const tap = (id, at, login = 'lecturer') => ({
        ...scan(id, at, login, login === 'lecturer' ? [lesson] : []),
        readerDirection: 'ENTRY', exitReaderId: '49919',
    });
    const taps = [
        tap('open', start),
        tap('early', time('10:00:02')),
        tap('student', time('10:00:10'), 'n57796'),
        tap('just-before', '2026-11-18T10:00:59.999Z'),
        tap('close', time('10:01:00')),
        tap('after-close', time('10:01:20'), 'n54321'),
    ];
    const { outcomes, sessions } = buildTimeline(taps, new Map());
    const [session] = sessions.values();
    assert.equal(outcomes.get('early'), 'close_too_soon');
    assert.equal(outcomes.get('just-before'), 'close_too_soon');
    assert.equal(outcomes.get('close'), 'closed');
    assert.equal(outcomes.get('after-close'), 'no_session');
    assert.equal(session.closesAt.toISOString(), time('10:01:00'));
    assert.deepEqual([...session.members.keys()], ['n57796']);
});

test('SmartService timestamps use Warsaw and snapshot positions do not change event identity', () => {
    const xml = (key) => '<Reply><item><key><string>' + key + '</string></key><value><SmartLinkDataValue>' +
        '<Value>2026-07-15  09:29:07 Access granted 0000:00A1 wisync_22</Value>' +
        '</SmartLinkDataValue></value></item></Reply>';
    const [first] = parseReaderSnapshot(xml('0'), '49919');
    const [next] = parseReaderSnapshot(xml('10'), '49919');
    assert.equal(first.key, next.key);
    assert.equal(first.occurredAt, '2026-07-15T07:29:07.000Z');
    assert.equal(first.alias, 'wisync_22');
    assert.equal(normalizeCardAlias(first.alias), 'WISYNC_22');
    assert.equal(normalizeCardAlias('wi_sync1'), 'WISYNC_1');
    assert.equal(normalizeCardAlias(' WI-SYNC-001 '), 'WISYNC_001');
    assert.equal(first.granted, true);
    assert.equal(parseCampusTime('2026-03-29T02:30:00'), null);
    assert.equal(parseCampusTime('2026-10-25T02:30:00'), null);
    assert.throws(() => parseReaderSnapshot('<!DOCTYPE item><item/>', '49919'));
});

test('SmartService backs off operator login outside its configured schedule', async () => {
    let requests = 0;
    const server = createServer((_request, response) => {
        requests++;
        response.end('<StandardFault><Message>SMARTLINK_INVALID_LOGIN_SCHEDULE. Error Code = 123</Message></StandardFault>');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
        const source = new SmartService(`http://127.0.0.1:${server.address().port}`, 'test', 'examplePassword');
        await assert.rejects(source.read('49919'), /outside its configured schedule/);
        await assert.rejects(source.read('49919'), /outside its configured schedule/);
        assert.equal(requests, 1);
    } finally {
        server.close();
    }
});

test('SmartService inventory distinguishes communication from lock state and service faults', () => {
    assert.deepEqual(parseSmartServiceDoors('<ArrayOfDoor><Door><PkData>49919</PkData><Description>Entrance</Description>' +
        '</Door><Door><Id>49920</Id></Door></ArrayOfDoor>'), [
        { id: '49919', label: 'Entrance' }, { id: '49920', label: null },
    ]);
    assert.deepEqual(parseSmartServiceDoors('<ArrayOfDoor/>'), []);
    assert.throws(() => parseSmartServiceDoors('<StandardFault><Message>SMARTLINK_INVALID_SESSION</Message></StandardFault>'), /INVALID_SESSION/);
    assert.equal(parseSmartServiceDoorState('<Door><Status>Locked</Status><CommunicationState>Connected</CommunicationState></Door>'), 'online');
    assert.equal(parseSmartServiceDoorState('<Door><ControllerFailure>Yes</ControllerFailure><Status>Reader disabled</Status></Door>'), 'offline');
    assert.equal(parseSmartServiceDoorState('<Door><Status>Locked</Status></Door>'), 'unknown');
});
