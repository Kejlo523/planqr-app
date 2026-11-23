import { AttendanceMember, AttendanceSession, Prisma } from '@prisma/client';
import { auditAction } from '../middlewares/auditMiddleware';
import { Response, Router } from 'express';
import { DateTime } from 'luxon';
import { z } from 'zod';
import { AuthRequest, requireLecturerAccess } from '../middlewares/authMiddleware';
import { CAMPUS_ZONE } from '../attendance/scheduleTime';
import {
    attendanceDb, lockRoom, projectRoom, readCandidates,
} from '../attendance/store';

const router = Router();
const idSchema = z.coerce.number().int().positive();
const listQuery = z.object({
    session_id: idSchema.optional(),
    sessionId: idSchema.optional(),
    lesson_id: z.string().min(1).max(180).optional(),
    from: z.string().datetime({ offset: true }).optional(),
    teacher: z.string().trim().min(1).max(180).optional(),
});
const memberBody = z.object({
    username: z.string().trim().min(1).max(100),
    entered_at: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/).optional(),
});

type SessionWithMembers = AttendanceSession & { members: AttendanceMember[] };
const memberView = (member: AttendanceMember) => ({
    id: member.id,
    userId: member.id,
    studentId: member.login,
    albumNumber: member.album ?? '',
    username: member.login,
    displayName: member.name,
    givenName: null,
    surname: null,
    cardHex: '',
    present: true,
    source: member.manual ? 'manual' : 'scanner',
    status: member.manual ? 'manual' : 'scanner',
    firstScannedAt: member.firstAt.toISOString(),
    lastScannedAt: member.lastAt.toISOString(),
    lastAccess: member.lastAt.toISOString(),
    enteredAt: DateTime.fromJSDate(member.firstAt, { zone: CAMPUS_ZONE }).toFormat('HH:mm:ss'),
    scanCount: member.count,
});

const sessionStatus = (session: AttendanceSession, now = new Date()) =>
    session.sentAt ? 'sent' : session.closesAt && session.closesAt <= now ? 'closed' : 'open';
const sessionView = (session: SessionWithMembers) => {
    const now = new Date();
    const status = sessionStatus(session, now);
    const closedAt = status === 'open' ? null : session.closesAt?.toISOString() ?? null;
    return {
        status,
        sessionId: session.id,
        dydaktykId: session.id,
        lessonId: session.lessonId,
        title: session.title,
        group: session.lessonGroup,
        room: session.roomLabel,
        lecturerId: session.ownerLogin,
        lecturerUsername: session.ownerLogin,
        lecturerDisplayName: session.ownerName,
        lecturerCardHex: '',
        doorId: session.readerId,
        exitReaderId: session.exitReaderId,
        openedAt: session.openedAt.toISOString(),
        closedAt,
        from: session.openedAt.toISOString(),
        to: closedAt ?? now.toISOString(),
        generatedAt: now.toISOString(),
        totalScans: session.members.reduce((total, member) => total + member.count, 0),
        totalPresent: session.members.length,
        truncated: false,
        students: session.members.map(memberView),
    };
};
const members = {
    members: { where: { removed: false }, orderBy: [{ firstAt: 'asc' }, { id: 'asc' }] },
} satisfies Prisma.AttendanceSessionInclude;
const owner = (req: AuthRequest) => ({ ownerLogin: req.user!.login.trim().toLowerCase(), voided: false });

class RequestError extends Error {
    constructor(public status: number, message: string) {
        super(message);
    }
}
const handle = (action: (req: AuthRequest, res: Response) => Promise<void>) =>
    async (req: AuthRequest, res: Response) => {
        res.set('Cache-Control', 'no-store');
        try {
            await action(req, res);
        } catch (error) {
            if (error instanceof RequestError) {
                res.status(error.status).json({ message: error.message });
            } else if (error instanceof z.ZodError) {
                res.status(400).json({ message: 'Invalid attendance request' });
            } else {
                console.error('[Attendance] Request failed.');
                res.status(500).json({ message: 'Attendance service unavailable' });
            }
        }
    };

async function editSession<T>(
    req: AuthRequest,
    edit: (tx: Prisma.TransactionClient, session: AttendanceSession) => Promise<T>,
) {
    const where = { ...owner(req), id: idSchema.parse(req.params.id) };
    return attendanceDb.$transaction(async (tx) => {
        const found = await tx.attendanceSession.findFirst({ where, select: { roomKey: true } });
        if (!found) throw new RequestError(404, 'Attendance session not found');
        await lockRoom(tx, found.roomKey);
        const session = await tx.attendanceSession.findFirst({ where });
        if (!session) throw new RequestError(404, 'Attendance session not found');
        return edit(tx, session);
    }, { timeout: 20_000 });
}

router.use(requireLecturerAccess);

router.get('/', handle(async (req, res) => {
    const sessions = await attendanceDb.attendanceSession.findMany({
        where: { ...owner(req), ...(req.query.active === 'true'
            ? { OR: [{ closesAt: null }, { closesAt: { gt: new Date() } }] } : {}) },
        orderBy: { openedAt: 'desc' },
        take: 500,
    });
    res.json({ sessions: sessions.map((session) => sessionView({ ...session, members: [] })) });
}));

router.get('/list', handle(async (req, res) => {
    const query = listQuery.parse(req.query);
    const id = query.session_id ?? query.sessionId;
    if (!id && !query.lesson_id) throw new RequestError(400, 'A lesson or session is required');
    let scope: Prisma.AttendanceSessionWhereInput = owner(req);
    if (query.teacher) {
        if (!req.user!.isAdmin) throw new RequestError(403, 'Teacher preview requires an administrator');
        const name = { equals: query.teacher, mode: 'insensitive' as const };
        const users = await attendanceDb.ldapUser.findMany({
            where: { displayName: name }, select: { username: true },
        });
        scope = {
            voided: false,
            OR: [{ teacherScheduleId: name }, { ownerName: name },
                { ownerLogin: { in: users.map(({ username }) => username) } }],
        };
    }
    const results = await attendanceDb.attendanceSession.findMany({
        where: {
            ...scope,
            ...(id ? { id } : { lessonId: query.lesson_id, lessonStart: query.from ? new Date(query.from) : undefined }),
        },
        include: members,
        take: 2,
    });
    if (!results.length) throw new RequestError(404, 'Attendance session not found');
    if (results.length > 1) throw new RequestError(409, 'Specify the occurrence start time');
    res.json(sessionView(results[0]));
}));

router.get('/pending', handle(async (req, res) => {
    const scans = await attendanceDb.attendanceScan.findMany({
        where: { login: owner(req).ownerLogin, outcome: 'choose_lesson' },
        orderBy: { occurredAt: 'desc' },
        take: 25,
    });
    res.json(scans.map((scan) => ({
        id: scan.id, room: scan.roomLabel, occurredAt: scan.occurredAt, choices: readCandidates(scan),
    })));
}));

router.post('/pending/:id/choose', auditAction('ATTENDANCE', 'Wybrano zajęcia dla listy obecności', () => undefined), handle(async (req, res) => {
    const key = z.string().min(1).max(400).parse(req.body?.key);
    const where = { id: req.params.id, login: owner(req).ownerLogin };
    await attendanceDb.$transaction(async (tx) => {
        const found = await tx.attendanceScan.findFirst({ where, select: { roomKey: true } });
        if (!found) throw new RequestError(404, 'Pending scan not found');
        await lockRoom(tx, found.roomKey);
        const scan = await tx.attendanceScan.findFirst({ where });
        if (scan?.selectedKey === key) return;
        if (!scan || scan.outcome !== 'choose_lesson') throw new RequestError(409, 'Scan already resolved');
        if (!readCandidates(scan).some((lesson) => lesson.key === key)) {
            throw new RequestError(400, 'Lesson is not a candidate for this scan');
        }
        await tx.attendanceScan.update({ where: { id: scan.id }, data: { selectedKey: key } });
        await projectRoom(tx, scan.roomKey);
    }, { timeout: 20_000 });
    res.sendStatus(204);
}));

router.post('/sessions/:id/close', auditAction('ATTENDANCE', 'Zamknięto listę obecności'), handle(async (req, res) => {
    await editSession(req, async (tx, session) => {
        const now = new Date();
        if (session.closesAt && session.closesAt <= now) return;
        if (session.exitReaderId) throw new RequestError(409, 'Close the list with the configured exit reader');
        await tx.attendanceSession.update({
            where: { id: session.id }, data: { manualClosedAt: now },
        });
        await projectRoom(tx, session.roomKey);
    });
    const session = await attendanceDb.attendanceSession.findFirst({
        where: { ...owner(req), id: idSchema.parse(req.params.id) }, include: members,
    });
    if (!session) throw new RequestError(404, 'Attendance session not found');
    res.json(sessionView(session));
}));

router.post('/sessions/:id/send', auditAction('ATTENDANCE', 'Przygotowano listę obecności do wysyłki'), handle(async (req, res) => {
    const updated = await editSession(req, async (tx, session) => {
        if (sessionStatus(session) === 'open') throw new RequestError(409, 'Close the attendance session first');
        return tx.attendanceSession.update({
            where: { id: session.id }, data: { sentAt: session.sentAt ?? new Date() }, include: members,
        });
    });
    res.json(sessionView(updated));
}));

router.post('/sessions/:id/users', auditAction('ATTENDANCE', 'Dodano osobę do listy obecności'), handle(async (req, res) => {
    const payload = memberBody.parse(req.body);
    const result = await editSession(req, async (tx, session) => {
        if (sessionStatus(session) !== 'open') throw new RequestError(409, 'Attendance session is closed');
        const login = payload.username.toLowerCase();
        let at = new Date();
        if (payload.entered_at) {
            const lessonDate = DateTime.fromJSDate(session.lessonStart, { zone: CAMPUS_ZONE });
            const [hour, minute, second = 0] = payload.entered_at.split(':').map(Number);
            at = lessonDate.set({ hour, minute, second, millisecond: 0 }).toJSDate();
        }
        if (at < session.openedAt || (session.closesAt && at >= session.closesAt)) {
            throw new RequestError(400, 'Attendance time must be within the session');
        }
        const album = /^\d+$/.test(login) ? login : null;
        const data = { name: payload.username, album, firstAt: at, lastAt: at, count: 1, manual: true, removed: false };
        return tx.attendanceMember.upsert({
            where: { sessionId_login: { sessionId: session.id, login } },
            create: { sessionId: session.id, login, ...data },
            update: data,
        });
    });
    res.status(201).json({ user: memberView(result) });
}));

router.delete('/sessions/:id/users/:userId', auditAction('ATTENDANCE', 'Usunięto osobę z listy obecności'), handle(async (req, res) => {
    const userId = idSchema.parse(req.params.userId);
    await editSession(req, async (tx, session) => {
        if (sessionStatus(session) !== 'open') throw new RequestError(409, 'Attendance session is closed');
        const updated = await tx.attendanceMember.updateMany({
            where: { id: userId, sessionId: session.id, removed: false }, data: { removed: true },
        });
        if (!updated.count) throw new RequestError(404, 'Attendance user not found');
    });
    res.sendStatus(204);
}));

export default router;
