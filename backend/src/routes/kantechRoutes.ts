import { timingSafeEqual } from 'node:crypto';
import { Request, Response, Router } from 'express';
import { z } from 'zod';
import { env } from '../config/env';
import { getMonitor, incomingReport, reportReader } from '../attendance/monitor';
import { ingestScans } from '../attendance/store';
import { attendanceScanRateLimiter } from '../middlewares/securityMiddleware';
import { requireLdapAdmin } from '../middlewares/authMiddleware';

export const kantechIngress = Router();
export const kantechEvents = Router();

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
 *       200: { description: Mode, readers, and masked recent events }
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
kantechEvents.get('/', requireLdapAdmin, (req, res) => {
    const parsed = query.safeParse(req.query);
    if (!parsed.success) {
        res.status(400).json({ message: 'Invalid event filters' });
        return;
    }
    res.set('Cache-Control', 'no-store');
    res.json({ mode: env.KANTECH_MODE, devTools: env.KANTECH_DEV_TOOLS, ...getMonitor(parsed.data.readerId, parsed.data.limit) });
});

async function acceptReport(req: Request, res: Response) {
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
        reportReader(report.data.readerId, report.data.state);
        await ingestScans(report.data.readerId, report.data.events);
        res.sendStatus(204);
    } catch {
        res.status(503).json({ message: 'Reader report could not be stored' });
    }
}

kantechEvents.post('/', requireLdapAdmin, attendanceScanRateLimiter, acceptReport);
kantechIngress.post('/', attendanceScanRateLimiter, async (req, res) => {
    const expected = Buffer.from('Bearer ' + (env.WORKER_SECRET_TOKEN ?? ''));
    const provided = Buffer.from(req.get('authorization') ?? '');
    if (!env.WORKER_SECRET_TOKEN || expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
        res.sendStatus(401);
        return;
    }
    await acceptReport(req, res);
});
