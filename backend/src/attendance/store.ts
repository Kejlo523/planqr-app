import { AttendanceScan, Prisma, PrismaClient } from '@prisma/client';
import { env } from '../config/env';
import { IncomingScan, reportScan, updateScanOutcome } from './monitor';
import { findLessons, getRoomKey } from './schedule';
import { buildTimeline, Lesson, lessonSchema } from './timeline';
import { cardAliasKeys } from './cardAlias';

export const attendanceDb = new PrismaClient();
const transactionOptions = { timeout: 20_000 };

export async function lockRoom(tx: Prisma.TransactionClient, roomKey: string) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${roomKey}, 0))`;
}

export function readCandidates(scan: AttendanceScan): Lesson[] {
    return lessonSchema.array().parse(scan.candidates ?? []);
}

export async function projectRoom(tx: Prisma.TransactionClient, roomKey: string) {
    const scans = await tx.attendanceScan.findMany({
        where: { roomKey }, orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
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
            lessonId: lesson.id, title: lesson.title,
            lessonStart: new Date(lesson.start), lessonEnd: new Date(lesson.end),
            ownerLogin: opener.login, ownerName: opener.name,
            roomKey, readerId: opener.readerId, roomLabel: opener.roomLabel,
            openedAt: opener.occurredAt, closesAt: session.closesAt, voided: false,
        };
        const stored = previous && !previous.voided
            && previous.openedAt.getTime() === data.openedAt.getTime()
            && previous.closesAt.getTime() === data.closesAt.getTime()
            && previous.readerId === data.readerId
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
    return outcomes;
}

export function publishOutcomes(outcomes?: Map<string, string>) {
    outcomes?.forEach((outcome, id) => updateScanOutcome(id, outcome));
}

export async function ingestScans(readerId: string, events: IncomingScan[]) {
    if (!events.length) return;
    const [reader, assignments] = await Promise.all([
        attendanceDb.attendanceReader.findUnique({ where: { id: readerId } }),
        attendanceDb.attendanceCard.findMany({ where: { alias: { in: [...new Set(events.flatMap((event) => cardAliasKeys(event.alias)))] } } }),
    ]);
    const roomKey = reader ? getRoomKey(reader.buildingId, reader.roomNumber) : '';
    const cards = new Map(assignments.map((card) => [card.alias, card]));
    const valid: IncomingScan[] = [];
    const data: Prisma.AttendanceScanCreateManyInput[] = [];
    for (const event of events) {
        const card = cardAliasKeys(event.alias).map((alias) => cards.get(alias)).find(Boolean);
        const occurredAt = event.occurredAt ? new Date(event.occurredAt) : null;
        const invalid = !reader ? 'unknown_reader' : !occurredAt ? 'invalid_time'
            : !event.granted ? 'access_denied' : !card ? 'unknown_card' : null;
        if (!reader || !card || !occurredAt || invalid || env.KANTECH_MODE === 'observe') {
            reportScan(event, invalid ?? 'observed', Boolean(card));
            continue;
        }
        if (occurredAt < new Date(env.KANTECH_ACTIVE_FROM!) || occurredAt.getTime() > Date.now() + 60_000) {
            reportScan(event, 'outside_cutover', true);
            continue;
        }
        valid.push(event);
        data.push({
            id: event.key, readerId, roomKey, buildingId: reader.buildingId, roomNumber: reader.roomNumber,
            roomLabel: reader.label, alias: card.alias, login: card.login, name: card.name, album: card.album,
            scheduleId: card.scheduleId, occurredAt, resolution: card.scheduleId ? 'pending' : 'none',
            retryAt: card.scheduleId ? new Date() : null,
        });
    }
    if (!data.length) return;
    const outcomes = await attendanceDb.$transaction(async (tx) => {
        await lockRoom(tx, roomKey);
        const result = await tx.attendanceScan.createMany({ data, skipDuplicates: true });
        if (result.count) return projectRoom(tx, roomKey);
        const stored = await tx.attendanceScan.findMany({
            where: { id: { in: data.map((scan) => scan.id) } },
            select: { id: true, outcome: true },
        });
        return new Map(stored.map((scan) => [scan.id, scan.outcome]));
    }, transactionOptions);
    for (const event of valid) reportScan(event, outcomes.get(event.key) ?? 'received', true);
    publishOutcomes(outcomes);
}

export async function resolvePendingScans() {
    const scans = await attendanceDb.attendanceScan.findMany({
        where: { resolution: 'pending', retryAt: { lte: new Date() } },
        orderBy: { retryAt: 'asc' },
        take: 10,
    });
    for (const scan of scans) {
        if (!scan.scheduleId) continue;
        let candidates: Lesson[];
        try {
            candidates = await findLessons(scan.scheduleId, scan.roomKey, scan.occurredAt);
        } catch {
            await attendanceDb.attendanceScan.updateMany({
                where: { id: scan.id, resolution: 'pending' },
                data: { retryAt: new Date(Date.now() + 15_000) },
            });
            continue;
        }
        const resolution = candidates.length > 1 ? 'choose_lesson' : candidates.length ? 'matched' : 'no_match';
        const outcomes = await attendanceDb.$transaction(async (tx) => {
            await lockRoom(tx, scan.roomKey);
            const updated = await tx.attendanceScan.updateMany({
                where: { id: scan.id, resolution: 'pending' },
                data: { resolution, candidates, retryAt: null },
            });
            if (!updated.count) return;
            return projectRoom(tx, scan.roomKey);
        }, transactionOptions);
        publishOutcomes(outcomes);
    }
}

export function startAttendanceJob() {
    if (env.KANTECH_MODE !== 'attendance') return;
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
