import { randomUUID } from 'node:crypto';
import { env } from '../config/env';
import { cardAliasKeys, normalizeCardAlias, normalizeCardLogin } from './cardAlias';
import { findLecturerLessons, findLessons, foldName } from './schedule';
import { attendanceIdentity } from './identity';
import { attendanceDb } from './store';
import { ATTENDANCE_RULES_VERSION, attendanceDeadline, buildTimeline, readerGroupScope, type Lesson, type Scan } from './timeline';
import { listKantechDevices } from './readerGroups';

interface SimulationInput {
    readerId: string;
    deviceId?: string;
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
    lesson?: Lesson;
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

export function getSimulationAttendance(login: string, lessonId: string, from: string, teacher: string) {
    const scopes = new Map<string, Scan[]>();
    for (const event of simulations.get(login) ?? []) {
        if (event.source !== 'live' || !event.scan) continue;
        const scans = scopes.get(event.scan.roomKey) ?? [];
        scans.push(event.scan);
        scopes.set(event.scan.roomKey, scans);
    }
    const teacherKey = (name: string) => name.trim().split(/\s+/).map(foldName).sort().join(' ');
    const key = teacherKey(teacher);
    const matchesTeacher = (name: string) => {
        const candidate = teacherKey(name);
        return candidate === key || (!key.includes(' ') && candidate.split(' ').includes(key));
    };
    const start = Date.parse(from);
    const session = [...scopes.values()].flatMap((scans) => [...buildTimeline(scans, new Map()).sessions.values()])
        .filter(({ lesson, opener }) => lesson.id === lessonId && Date.parse(lesson.start) === start
            && [lesson.teacherName, lesson.teacherScheduleId, opener.name, opener.login]
                .some((name) => name && matchesTeacher(name)))
        .sort((first, second) => +second.opener.occurredAt - +first.opener.occurredAt)[0];
    if (!session) return;
    const lastScan = scopes.get(session.opener.roomKey)?.at(-1)?.occurredAt ?? session.opener.occurredAt;
    return { session, now: new Date(Math.max(Date.now(), +lastScan)) };
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
    const groupId = reader?.groupId;
    const previewReader = input.deviceId && groupId == null
        ? (await listKantechDevices()).find(({ id, groupName }) => id === input.deviceId && groupName === null)
            ?.readers.find(({ id }) => id === input.readerId)
        : undefined;
    const scope = groupId != null ? readerGroupScope(groupId) : previewReader ? 'group:preview:' + input.deviceId : null;
    const entry = !scope && reader?.direction === 'EXIT' ? reader.entryReader : reader;
    const exitReaderId = previewReader ? (previewReader.role === 'BOTH' ? previewReader.id : null)
        : entry?.singleReader ? entry.id : entry?.exitReaderId ?? null;
    const direction = previewReader ? (previewReader.role === 'EXIT' ? 'EXIT' : 'ENTRY') : reader?.direction;
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
    } else if (input.deviceId && reader?.deviceId !== input.deviceId && !previewReader) {
        event.outcome = 'unknown_reader';
    } else if (input.source === 'live' && !reader && !previewReader) {
        event.outcome = 'unknown_reader';
    } else if (input.source === 'live' && !scope) {
        event.outcome = 'reader_without_group';
    } else {
        const demoStart = Date.parse(events.find((item) => item.source === 'demo')?.occurredAt ?? event.occurredAt);
        const configured = Boolean(scope || exitReaderId);
        const candidates = card.isLecturer && (!configured || direction === 'ENTRY') ? input.source === 'demo' ? [{
            id: 'demo', key: 'demo-session', title: 'Zajęcia testowe',
            start: new Date(demoStart).toISOString(),
            end: new Date(demoStart + 60 * 60_000).toISOString(),
        }] : card.scheduleId ? await findLessons(card.scheduleId, at, env.ZUT_SCHEDULE_STUDENT_URL)
            : await findLecturerLessons(card.login, profile, at, env.ZUT_SCHEDULE_STUDENT_URL) : [];
        const simulatedRoom = scope ? `${scope}:${input.source}` : JSON.stringify([input.source, entry?.id ?? input.readerId]);
        event.scan = {
            id, readerId: input.readerId, roomKey: simulatedRoom, roomLabel: previewReader?.label ?? entry?.label ?? 'Sala testowa',
            alias, login: card.login, name: card.name, album: card.album, scheduleId: card.scheduleId,
            readerDirection: configured ? direction : null, exitReaderId, isLecturer: card.isLecturer,
            rulesVersion: configured ? ATTENDANCE_RULES_VERSION : undefined,
            occurredAt: at, candidates, selectedKey: null, resolution: 'no_match',
        };
        const scans = events.flatMap((item) => item.scan?.roomKey === simulatedRoom ? [item.scan] : []);
        const timeline = buildTimeline([...scans, event.scan], new Map());
        event.outcome = timeline.outcomes.get(id) ?? 'received';
        if (input.source === 'live' && event.outcome === 'no_match' && candidates.length
            && candidates.every(({ end }) => +at >= attendanceDeadline(end))) {
            event.outcome = 'attendance_cutoff';
        }
        event.lesson = [...timeline.sessions.values()].find(({ opener }) => opener.id === id)?.lesson;
    }

    const latest = simulations.get(login) ?? [];
    simulations.delete(login);
    simulations.set(login, [...latest, event].slice(-100));
    if (simulations.size > 32) simulations.delete(simulations.keys().next().value!);
    return getSimulation(login);
}
