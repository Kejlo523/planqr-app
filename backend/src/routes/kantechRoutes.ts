import { timingSafeEqual } from 'node:crypto';
import { auditAction } from '../middlewares/auditMiddleware';
import { json, NextFunction, Request, Response, Router } from 'express';
import { z } from 'zod';
import { env } from '../config/env';
import { getMonitor, incomingReport } from '../attendance/monitor';
import { captureSettingsInput, readCaptureSettings, updateCaptureSettings } from '../attendance/captureSettings';
import { saveReaderReport } from '../attendance/reports';
import { inventoryReaders, saveInventory } from '../attendance/inventory';
import { deleteReaderGroup, listReaderGroups, readerGroupInput, saveReaderGroup } from '../attendance/readerGroups';
import { attendanceDb } from '../attendance/store';
import {
    deleteReader, listReaders, ReaderConfigurationError, readerIdSchema, readerInput, readerSetupInput, saveReader, saveReaderSetup,
} from '../attendance/readers';
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
        const [monitor, settings] = await Promise.all([
            getMonitor(attendanceDb, parsed.data.readerId, parsed.data.limit),
            env.KANTECH_MODE === 'off' ? null : readCaptureSettings(attendanceDb),
        ]);
        res.json({ mode: settings?.mode ?? env.KANTECH_MODE, devTools: env.KANTECH_DEV_TOOLS, ...monitor });
    } catch {
        res.status(503).json({ message: 'Reader monitor unavailable' });
    }
});

kantechEvents.post('/mode', requireLdapAdmin,
    auditAction('KANTECH', 'Zmieniono tryb Kantecha', (req) =>
        req.body?.mode === 'attendance' ? 'Zapis obecności' : 'Tryb obserwacji'),
    async (req, res) => {
        if (env.KANTECH_MODE === 'off') {
            res.status(409).json({ message: 'Odczyt Kantecha jest wyłączony w konfiguracji serwera.' });
            return;
        }
        const input = captureSettingsInput.safeParse(req.body);
        if (!input.success) {
            res.status(400).json({ message: 'Nieprawidłowy tryb Kantecha.' });
            return;
        }
        try {
            res.set('Cache-Control', 'no-store');
            res.json(await updateCaptureSettings(attendanceDb, input.data.mode));
        } catch {
            res.status(503).json({ message: 'Nie udało się zmienić trybu Kantecha.' });
        }
    },
);

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
kantechIngress.post('/', attendanceScanRateLimiter, json({ limit: '32kb' }), (req, res) => void acceptReport(req, res, true));
kantechIngress.post('/inventory', json({ limit: '4mb' }), async (req, res) => {
    if (env.KANTECH_MODE === 'off') {
        res.sendStatus(404);
        return;
    }
    const report = inventoryReaders.safeParse(req.body);
    if (!report.success) {
        res.sendStatus(400);
        return;
    }
    try {
        await saveInventory(attendanceDb, report.data);
        res.sendStatus(204);
    } catch {
        res.sendStatus(503);
    }
});

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

kantechReaders.get('/inventory', async (_req, res) => {
    try {
        const snapshot = await attendanceDb.kantechInventory.findUnique({
            where: { id: 1 }, select: { readers: true, checkedAt: true },
        });
        res.json(snapshot ?? { readers: [], checkedAt: null });
    } catch {
        res.sendStatus(503);
    }
});

kantechReaders.get('/groups', async (_req, res) => {
    try {
        res.json(await listReaderGroups());
    } catch {
        res.status(503).json({ message: 'Nie udało się pobrać grup i urządzeń RCP.' });
    }
});

kantechReaders.post('/groups', auditAction('KANTECH', 'Zapisano grupę urządzeń RCP', (req) => req.body?.name), async (req, res) => {
    try {
        const input = readerGroupInput.parse(req.body);
        res.status(input.id ? 200 : 201).json(await saveReaderGroup(input));
    } catch (error) {
        if (error instanceof z.ZodError) res.status(400).json({ message: 'Sprawdź nazwę, urządzenia i role czytników.' });
        else if (error instanceof ReaderConfigurationError) res.status(409).json({ message: error.message });
        else res.status(503).json({ message: 'Nie udało się zapisać grupy RCP.' });
    }
});

kantechReaders.delete('/groups/:id', auditAction('KANTECH', 'Usunięto grupę urządzeń RCP'), async (req, res) => {
    try {
        await deleteReaderGroup(req.params.id);
        res.sendStatus(204);
    } catch (error) {
        if (error instanceof z.ZodError) res.status(400).json({ message: 'Nieprawidłowe ID grupy.' });
        else if (error instanceof ReaderConfigurationError) res.status(409).json({ message: error.message });
        else res.status(503).json({ message: 'Nie udało się usunąć grupy RCP.' });
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
        res.json(await saveReader(input.data));
    } catch (error) {
        if (error instanceof ReaderConfigurationError) {
            res.status(409).json({ message: error.message });
            return;
        }
        res.status(503).json({ message: 'Nie udało się zapisać czytnika.' });
    }
});

kantechReaders.post('/setup', auditAction('KANTECH', 'Skonfigurowano wejście i wyjście', (req) => req.body?.entry?.id), async (req, res) => {
    const input = readerSetupInput.safeParse(req.body);
    if (!input.success) {
        res.status(400).json({ message: input.error.issues.find(({ code }) => code === 'custom')?.message
            ?? 'Uzupełnij ID i nazwę dla każdego używanego czytnika.' });
        return;
    }
    try {
        res.status(input.data.edit ? 200 : 201).json(await saveReaderSetup(input.data));
    } catch (error) {
        if (error instanceof ReaderConfigurationError) {
            res.status(409).json({ message: error.message });
            return;
        }
        res.status(503).json({ message: 'Nie udało się zapisać konfiguracji czytników.' });
    }
});

kantechReaders.delete('/:id', auditAction('KANTECH', 'Usunięto czytnik'), async (req, res) => {
    const id = readerIdSchema.safeParse(req.params.id);
    if (!id.success) {
        res.status(400).json({ message: 'Nieprawidłowe ID czytnika.' });
        return;
    }
    try {
        await deleteReader(id.data);
        res.sendStatus(204);
    } catch (error) {
        if (error instanceof ReaderConfigurationError) {
            res.status(409).json({ message: error.message });
            return;
        }
        res.status(503).json({ message: 'Nie udało się usunąć czytnika.' });
    }
});
