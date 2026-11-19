import { timingSafeEqual } from 'node:crypto';
import { auditAction } from '../middlewares/auditMiddleware';
import { NextFunction, Request, Response, Router } from 'express';
import { z } from 'zod';
import { env } from '../config/env';
import { getMonitor, incomingReport } from '../attendance/monitor';
import { saveReaderReport } from '../attendance/reports';
import { attendanceDb } from '../attendance/store';
import { ensureReaderSetup, listReaders, readerIdSchema, readerInput } from '../attendance/readers';
import { attendanceScanRateLimiter } from '../middlewares/securityMiddleware';
import { requireLdapAdmin } from '../middlewares/authMiddleware';

export const kantechIngress = Router();
export const kantechEvents = Router();
export const kantechReaders = Router();

const query = z.object({
    readerId: z.string().trim().min(1).max(64).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
});

/**
 * @swagger
 * /api/kantech/events:
 *   get:
 *     summary: Read recent Kantech events and reader status as an LDAP administrator
 *     tags: [Kantech]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - { name: readerId, in: query, schema: { type: string } }
 *       - { name: limit, in: query, schema: { type: integer, minimum: 1, maximum: 100 } }
 *     responses:
 *       200: { description: 'Mode, readers, and recent events with full card identifiers in label' }
 *       401: { description: Sign-in required }
 *       403: { description: LDAP administrator required }
 *   post:
 *     summary: Submit a card event or a batch as an LDAP administrator
 *     tags: [Kantech]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           example: { readerId: "49919", alias: "WISYNC_2", occurredAt: "2026-11-18T09:00:00Z", granted: true }
 *     responses:
 *       204: { description: Accepted }
 *       400: { description: Invalid event payload }
 *       401: { description: Sign-in required }
 *       403: { description: LDAP administrator required }
 */
kantechEvents.get('/', requireLdapAdmin, async (req, res) => {
    const parsed = query.safeParse(req.query);
    if (!parsed.success) {
        res.status(400).json({ message: 'Invalid event filters' });
        return;
    }
    res.set('Cache-Control', 'no-store');
    try {
        const monitor = await getMonitor(attendanceDb, parsed.data.readerId, parsed.data.limit);
        res.json({ mode: env.KANTECH_MODE, devTools: env.KANTECH_DEV_TOOLS, ...monitor });
    } catch {
        res.status(503).json({ message: 'Reader monitor unavailable' });
    }
});

async function acceptReport(req: Request, res: Response, worker = false) {
    if (env.KANTECH_MODE === 'off') {
        res.sendStatus(404);
        return;
    }
    const report = incomingReport.safeParse(req.body);
    if (!report.success) {
        res.status(400).json({ message: 'Invalid reader report' });
        return;
    }
    try {
        await saveReaderReport(attendanceDb, report.data, env.KANTECH_MODE, worker);
        res.sendStatus(204);
    } catch {
        res.status(503).json({ message: 'Reader report could not be stored' });
    }
}

kantechEvents.post('/', requireLdapAdmin, attendanceScanRateLimiter, (req, res) => void acceptReport(req, res));

function requireWorker(req: Request, res: Response, next: NextFunction) {
    const expected = Buffer.from('Bearer ' + (env.WORKER_SECRET_TOKEN ?? ''));
    const provided = Buffer.from(req.get('authorization') ?? '');
    if (!env.WORKER_SECRET_TOKEN || expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
        res.sendStatus(401);
        return;
    }
    next();
}

kantechIngress.use(requireWorker);
kantechIngress.get('/readers', async (_req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
        const readers = await listReaders();
        res.json({ readerIds: readers.map(({ id }) => id) });
    } catch {
        res.sendStatus(503);
    }
});
kantechIngress.post('/', attendanceScanRateLimiter, (req, res) => void acceptReport(req, res, true));

kantechReaders.use(requireLdapAdmin, (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
});

kantechReaders.get('/', async (_req, res) => {
    try {
        res.json({ readers: await listReaders(), devTools: env.KANTECH_DEV_TOOLS });
    } catch {
        res.status(503).json({ message: 'Nie udało się pobrać czytników.' });
    }
});

kantechReaders.post('/', auditAction('KANTECH', 'Zapisano czytnik', (req) => req.body?.id), async (req, res) => {
    const input = readerInput.safeParse(req.body);
    if (!input.success) {
        const assignmentError = input.error.issues.find(({ code }) => code === 'custom');
        res.status(400).json({ message: assignmentError?.message ?? 'Sprawdź ID, nazwę i dane sali.' });
        return;
    }
    try {
        await ensureReaderSetup();
        const reader = input.data;
        res.json(await attendanceDb.attendanceReader.upsert({
            where: { id: reader.id }, create: reader, update: reader,
        }));
    } catch {
        res.status(503).json({ message: 'Nie udało się zapisać czytnika.' });
    }
});

kantechReaders.delete('/:id', auditAction('KANTECH', 'Usunięto czytnik'), async (req, res) => {
    const id = readerIdSchema.safeParse(req.params.id);
    if (!id.success) {
        res.status(400).json({ message: 'Nieprawidłowe ID czytnika.' });
        return;
    }
    try {
        await ensureReaderSetup();
        await attendanceDb.attendanceReader.deleteMany({ where: { id: id.data } });
        res.sendStatus(204);
    } catch {
        res.status(503).json({ message: 'Nie udało się usunąć czytnika.' });
    }
});
