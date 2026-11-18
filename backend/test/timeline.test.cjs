const assert = require('node:assert/strict');
const test = require('node:test');
const { buildTimeline } = require('../dist/attendance/timeline');
const { parseReaderSnapshot } = require('../dist/attendance/smartService');
const { parseCampusTime } = require('../dist/attendance/scheduleTime');
const { normalizeCardAlias } = require('../dist/attendance/cardAlias');

const start = '2026-11-18T10:00:00.000Z';
const end = '2026-11-18T11:00:00.000Z';
const lesson = { key: 'first', id: '42', title: 'Test', start, end };
const scan = (id, time, login, candidates = [], selectedKey = null) => ({
    id, readerId: '49919', roomKey: 'test-201', roomLabel: '201', alias: login, login, name: login,
    album: null, scheduleId: login === 'lecturer' ? '123' : null,
    occurredAt: new Date(time), candidates, selectedKey, resolution: candidates.length ? 'matched' : 'no_match',
});
const time = (value) => '2026-11-18T' + value + '.000Z';

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
