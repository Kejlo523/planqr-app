import { randomUUID } from 'node:crypto';
import { env } from '../config/env';
import { cardAliasKeys, normalizeCardAlias, normalizeCardLogin } from './cardAlias';
import { findLecturerLessons, findLessons, getRoomKey } from './schedule';
import { attendanceIdentity } from './identity';
import { attendanceDb } from './store';
import { buildTimeline, Scan } from './timeline';

interface SimulationInput {
    readerId: string;
    alias: string;
    source: 'demo' | 'live';
    granted: boolean;
}

interface SimulationEvent extends SimulationInput {
    id: string;
    label: string;
    occurredAt: string;
    outcome: string;
    scan?: Scan;
}

const demoCards = new Map([
    ['WISYNC_1', { login: 'demo-lecturer', name: 'Prowadzący testowy', album: null, scheduleId: 'demo' }],
    ['WISYNC_2', { login: 'demo-student', name: 'Student testowy', album: '123456', scheduleId: null }],
    ['WISYNC_3', { login: 'demo-visitor', name: 'Gość testowy', album: null, scheduleId: null }],
]);
const simulations = new Map<string, SimulationEvent[]>();

function snapshot(events: SimulationEvent[]) {
    return events.slice().reverse().map(({ scan: _scan, ...event }) => event);
}

export function getSimulation(login: string) {
    return snapshot(simulations.get(login) ?? []);
}

export function resetSimulation(login: string) {
    simulations.delete(login);
}

export async function simulateScan(login: string, input: SimulationInput) {
    const aliases = cardAliasKeys(input.alias);
    const [reader, cards, profile] = await Promise.all([
        attendanceDb.attendanceReader.findUnique({ where: { id: input.readerId }, include: { entryReader: true } }),
        attendanceDb.attendanceCard.findMany({ where: { alias: { in: aliases } } }),
        attendanceDb.ldapUser.findUnique({ where: { username: normalizeCardLogin(input.alias) } }),
    ]);
    const alias = normalizeCardAlias(input.alias);
    const binding = aliases.map((candidate) => cards.find((item) => item.alias === candidate)).find(Boolean);
    const demoCard = input.source === 'demo' ? demoCards.get(alias) : undefined;
    const card = attendanceIdentity(input.alias, binding, profile)
        ?? (demoCard && { ...demoCard, isLecturer: Boolean(demoCard.scheduleId) });
    const entry = reader?.direction === 'EXIT' ? reader.entryReader : reader;
    const exitReaderId = entry?.singleReader ? entry.id : entry?.exitReaderId ?? null;
    const events = simulations.get(login) ?? [];
    const last = events[events.length - 1];
    const at = new Date(Math.max(Date.now(), last ? Date.parse(last.occurredAt) + 3_000 : 0));
    const id = randomUUID();
    const event: SimulationEvent = {
        ...input, id, occurredAt: at.toISOString(), label: card?.name ?? alias, outcome: 'received',
    };
    if (!input.granted) {
        event.outcome = 'access_denied';
    } else if (!card) {
        event.outcome = 'unknown_card';
    } else if (input.source === 'live' && !reader) {
        event.outcome = 'unknown_reader';
    } else if (input.source === 'live' && !exitReaderId) {
        event.outcome = 'reader_without_pair';
    } else if (input.source === 'live' && (!entry?.buildingId || !entry.roomNumber)) {
        event.outcome = 'reader_without_room';
    } else {
        const roomKey = entry?.buildingId && entry.roomNumber
            ? getRoomKey(entry.buildingId, entry.roomNumber) : entry?.id ?? input.readerId;
        const demoStart = Date.parse(events.find((item) => item.source === 'demo')?.occurredAt ?? event.occurredAt);
        const candidates = card.isLecturer && (!exitReaderId || reader?.direction === 'ENTRY') ? input.source === 'demo' ? [{
            id: 'demo', key: 'demo-session', title: 'Zajęcia testowe',
            start: new Date(demoStart).toISOString(),
            end: new Date(demoStart + 60 * 60_000).toISOString(),
        }] : card.scheduleId ? await findLessons(card.scheduleId, roomKey, at, env.ZUT_ATTENDANCE_SCHEDULE_URL)
            : await findLecturerLessons(card.login, profile, roomKey, entry!.roomNumber, at) : [];
        const simulatedRoom = JSON.stringify([input.source, roomKey]);
        event.scan = {
            id, readerId: input.readerId, roomKey: simulatedRoom, roomLabel: entry?.label ?? 'Sala testowa',
            alias, login: card.login, name: card.name, album: card.album, scheduleId: card.scheduleId,
            readerDirection: exitReaderId ? reader?.direction : null, exitReaderId, isLecturer: card.isLecturer,
            occurredAt: at, candidates, selectedKey: null, resolution: 'no_match',
        };
        const scans = events.flatMap((item) => item.scan?.roomKey === simulatedRoom ? [item.scan] : []);
        const timeline = buildTimeline([...scans, event.scan], new Map());
        event.outcome = timeline.outcomes.get(id) ?? 'received';
    }

    const latest = simulations.get(login) ?? [];
    simulations.delete(login);
    simulations.set(login, [...latest, event].slice(-100));
    if (simulations.size > 32) simulations.delete(simulations.keys().next().value!);
    return getSimulation(login);
}
