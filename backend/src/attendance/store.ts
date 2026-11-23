import { AttendanceScan, KantechEvent, Prisma, PrismaClient } from '@prisma/client';
import { env } from '../config/env';
import { findLecturerLessons, findLessons, getRoomKey } from './schedule';
import { buildTimeline, Lesson, lessonSchema } from './timeline';
import { cardAliasKeys } from './cardAlias';
import { attendanceIdentity } from './identity';

export const attendanceDb = new PrismaClient();
const transactionOptions = { timeout: 20_000 };

export async function lockRoom(tx: Prisma.TransactionClient, roomKey: string) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${roomKey}, 0))`;
}

export async function lockReaderConfiguration(tx: Prisma.TransactionClient) {
    await lockRoom(tx, 'planqr:reader-pairs');
}

export function readCandidates(scan: AttendanceScan): Lesson[] {
    return lessonSchema.array().parse(scan.candidates ?? []);
}

export async function projectRoom(tx: Prisma.TransactionClient, roomKey: string) {
    const scans = await tx.attendanceScan.findMany({
        where: { roomKey }, orderBy: [{ occurredAt: 'asc' }, { readerDirection: 'asc' }, { isLecturer: 'desc' }, { id: 'asc' }],
    });
    const existing = await tx.attendanceSession.findMany({
        where: { roomKey }, include: { members: true },
    });
    const byKey = new Map(existing.map((session) => [session.key, session]));
    const manualCloses = new Map(existing.flatMap((session) =>
        session.manualClosedAt ? [[session.key, session.manualClosedAt] as const] : [],
    ));
    const { sessions, outcomes } = buildTimeline(
        scans.map((scan) => ({ ...scan, candidates: readCandidates(scan) })), manualCloses,
    );
    for (const scan of scans) {
        const outcome = outcomes.get(scan.id)!;
        if (outcome !== scan.outcome) {
            await tx.attendanceScan.update({ where: { id: scan.id }, data: { outcome } });
        }
    }

    const voided = existing.filter(({ key, voided }) => !voided && !sessions.has(key)).map(({ id }) => id);
    if (voided.length) {
        await tx.attendanceSession.updateMany({ where: { id: { in: voided } }, data: { voided: true } });
    }

    for (const session of sessions.values()) {
        const { opener, lesson } = session;
        const previous = byKey.get(session.key);
        const data = {
            lessonId: lesson.id, title: lesson.title, lessonGroup: lesson.group ?? null,
            teacherScheduleId: lesson.teacherScheduleId ?? opener.scheduleId,
            lessonStart: new Date(lesson.start), lessonEnd: new Date(lesson.end),
            ownerLogin: opener.login, ownerName: lesson.teacherName || opener.name,
            roomKey, readerId: opener.readerId, roomLabel: lesson.room || opener.roomLabel,
            exitReaderId: opener.exitReaderId ?? null,
            openedAt: opener.occurredAt, closesAt: session.closesAt, voided: false,
        };
        const stored = previous && !previous.voided
            && previous.openedAt.getTime() === data.openedAt.getTime()
            && previous.closesAt?.getTime() === data.closesAt?.getTime()
            && previous.readerId === data.readerId
            && previous.exitReaderId === data.exitReaderId
            && previous.roomLabel === data.roomLabel
            && previous.lessonGroup === data.lessonGroup
            && previous.teacherScheduleId === data.teacherScheduleId
            && previous.ownerName === data.ownerName
            ? previous
            : previous
                ? await tx.attendanceSession.update({ where: { id: previous.id }, data })
                : await tx.attendanceSession.create({ data: { ...data, key: session.key } });

        const removed = previous?.members
            .filter((member) => !member.manual && !member.removed && !session.members.has(member.login))
            .map(({ id }) => id) ?? [];
        if (removed.length) await tx.attendanceMember.deleteMany({ where: { id: { in: removed } } });

        const members = new Map(previous?.members.map((member) => [member.login, member]));
        for (const value of session.members.values()) {
            const member = members.get(value.login);
            if (member?.manual || member?.removed) continue;
            if (!member) {
                await tx.attendanceMember.create({ data: { ...value, sessionId: stored.id } });
            } else if (member.count !== value.count || +member.firstAt !== +value.firstAt || +member.lastAt !== +value.lastAt) {
                await tx.attendanceMember.update({ where: { id: member.id }, data: value });
            }
        }
    }
}

async function ingestScans(tx: Prisma.TransactionClient, readerId: string, events: KantechEvent[]) {
    await lockReaderConfiguration(tx);
    const [reader, assignments, profiles] = await Promise.all([
        tx.attendanceReader.findUnique({ where: { id: readerId }, include: { entryReader: true } }),
        tx.attendanceCard.findMany({ where: { alias: { in: [...new Set(events.flatMap((event) => cardAliasKeys(event.alias)))] } } }),
        tx.ldapUser.findMany({ where: { username: { in: [...new Set(events.map((event) => event.alias.trim().toLowerCase()))] } } }),
    ]);
    const entry = reader?.direction === 'EXIT' ? reader.entryReader : reader;
    const exitReaderId = entry?.singleReader ? entry.id : entry?.exitReaderId ?? null;
    const roomKey = entry?.buildingId && entry.roomNumber ? getRoomKey(entry.buildingId, entry.roomNumber) : '';
    const cards = new Map(assignments.map((card) => [card.alias, card]));
    const profilesByLogin = new Map(profiles.map((profile) => [profile.username, profile]));
    const results = new Map<string, string[]>();
    const data: Prisma.AttendanceScanCreateManyInput[] = [];
    const legacyCutover = env.KANTECH_ACTIVE_FROM ? Date.parse(env.KANTECH_ACTIVE_FROM) : Infinity;
    for (const event of events) {
        const binding = cardAliasKeys(event.alias).map((alias) => cards.get(alias)).find(Boolean);
        const card = attendanceIdentity(event.alias, binding, profilesByLogin.get(event.alias.trim().toLowerCase()));
        const { occurredAt } = event;
        const invalid = !reader ? 'unknown_reader' : !occurredAt ? 'invalid_time'
            : !event.granted ? 'access_denied' : !card ? 'unknown_card'
            : !exitReaderId && event.captureMode === 'attendance' ? 'reader_without_pair'
            : !roomKey && event.captureMode === 'attendance' ? 'reader_without_room' : null;
        let outcome = invalid ?? 'observed';
        if (reader?.direction && entry && card && occurredAt && !invalid && event.captureMode === 'attendance') {
            outcome = 'outside_cutover';
            const cutover = event.captureActiveFrom?.getTime() ?? legacyCutover;
            if (+occurredAt >= cutover && +occurredAt <= Date.now() + 60_000) {
                outcome = 'received';
                data.push({
                    id: event.id, readerId, roomKey, buildingId: entry.buildingId, roomNumber: entry.roomNumber,
                    roomLabel: entry.label, alias: card.alias, login: card.login, name: card.name, album: card.album,
                    readerDirection: reader.direction, exitReaderId, isLecturer: card.isLecturer,
                    scheduleId: card.scheduleId, occurredAt, receivedAt: event.receivedAt,
                    resolution: card.isLecturer && reader.direction === 'ENTRY' ? 'pending' : 'none',
                    retryAt: card.isLecturer && reader.direction === 'ENTRY' ? new Date() : null,
                });
            }
        }
        const ids = results.get(outcome) ?? [];
        ids.push(event.id);
        results.set(outcome, ids);
    }
    if (data.length) {
        await lockRoom(tx, roomKey);
        const result = await tx.attendanceScan.createMany({ data, skipDuplicates: true });
        if (result.count) await projectRoom(tx, roomKey);
    }
    for (const [outcome, ids] of results) {
        await tx.kantechEvent.updateMany({ where: { id: { in: ids } }, data: { outcome } });
    }
}

function processKantechBatch() {
    const pending = Prisma.sql`"outcome" IS NULL AND (
        "captureMode" = 'observe' OR "captureActiveFrom" IS NOT NULL OR ${env.KANTECH_MODE === 'attendance'}
    )`;
    return attendanceDb.$transaction(async (tx) => {
        const events = await tx.$queryRaw<KantechEvent[]>`
            SELECT * FROM "KantechEvent" WHERE ${pending} AND "readerId" = (
                SELECT "readerId" FROM "KantechEvent" WHERE ${pending} ORDER BY "receivedAt", id LIMIT 1
            ) ORDER BY "receivedAt", id LIMIT 75 FOR UPDATE SKIP LOCKED
        `;
        if (!events.length) return false;
        await ingestScans(tx, events[0].readerId, events);
        return true;
    }, transactionOptions);
}

export function startKantechIngestionJob() {
    if (env.KANTECH_MODE === 'off') return;
    let working = false;
    let cleanupAt = 0;
    setInterval(async () => {
        if (working) return;
        working = true;
        try {
            for (let batch = 0; batch < 5; batch += 1) {
                if (!await processKantechBatch()) break;
            }
            if (Date.now() >= cleanupAt) {
                cleanupAt = Date.now() + 60 * 60 * 1000;
                const receivedAt = { lt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) };
                await attendanceDb.kantechEvent.deleteMany({ where: { receivedAt, outcome: { not: null } } });
            }
        } catch {
            console.error('[Kantech] Could not process the reading queue.');
        } finally {
            working = false;
        }
    }, 1_000).unref();
}

export async function resolvePendingScans() {
    const scans = await attendanceDb.attendanceScan.findMany({
        where: { resolution: 'pending', retryAt: { lte: new Date() } },
        orderBy: { retryAt: 'asc' },
        take: 10,
    });
    for (const scan of scans) {
        let candidates: Lesson[];
        try {
            candidates = scan.scheduleId
                ? await findLessons(scan.scheduleId, scan.roomKey, scan.occurredAt)
                : await findLecturerLessons(scan.login, await attendanceDb.ldapUser.findUnique({
                    where: { username: scan.login }, select: { givenName: true, surname: true },
                }), scan.roomKey, scan.roomNumber, scan.occurredAt);
        } catch {
            await attendanceDb.attendanceScan.updateMany({
                where: { id: scan.id, resolution: 'pending' },
                data: { retryAt: new Date(Date.now() + 15_000) },
            });
            continue;
        }
        const resolution = candidates.length > 1 ? 'choose_lesson' : candidates.length ? 'matched' : 'no_match';
        await attendanceDb.$transaction(async (tx) => {
            await lockRoom(tx, scan.roomKey);
            const updated = await tx.attendanceScan.updateMany({
                where: { id: scan.id, resolution: 'pending' },
                data: { resolution, candidates, retryAt: null },
            });
            if (!updated.count) return;
            await projectRoom(tx, scan.roomKey);
        }, transactionOptions);
    }
}

export function startAttendanceJob() {
    if (env.KANTECH_MODE === 'off') return;
    let working = false;
    setInterval(async () => {
        if (working) return;
        working = true;
        try {
            await resolvePendingScans();
        } catch {
            console.error('[Attendance] Could not resolve queued attendance scans.');
        } finally {
            working = false;
        }
    }, 2_000).unref();
}
