import { Response, Router } from 'express';
import { auditAction } from '../middlewares/auditMiddleware';
import { z } from 'zod';
import { AuthRequest, requireLdapAdmin } from '../middlewares/authMiddleware';
import { attendanceScanRateLimiter } from '../middlewares/securityMiddleware';
import { normalizeCardAlias } from '../attendance/cardAlias';
import { getSimulation, resetSimulation, simulateScan } from '../attendance/devSimulation';
import { getObservedAliases } from '../attendance/monitor';
import { getTeacherSchedule } from '../attendance/schedule';
import { attendanceDb } from '../attendance/store';
import { listReaders } from '../attendance/readers';
import { env } from '../config/env';

export const kantechDevRoutes = Router();

const text = z.string().trim().min(1).max(128);
const mapping = z.discriminatedUnion('role', [
    z.object({ alias: text, role: z.literal('participant'), target: text, name: text.optional() }),
    z.object({ alias: text, role: z.literal('lecturer'), login: text, name: text, scheduleId: text }),
]);
const simulation = z.object({
    readerId: text.max(64), alias: text,
    source: z.enum(['demo', 'live']), granted: z.boolean().default(true),
});
const owner = (req: AuthRequest) => req.user!.login.toLowerCase();

kantechDevRoutes.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!env.KANTECH_DEV_TOOLS) {
        res.sendStatus(404);
        return;
    }
    next();
}, requireLdapAdmin);

const api = (handler: (req: AuthRequest, res: Response) => Promise<void>) =>
    async (req: AuthRequest, res: Response) => {
        try {
            await handler(req, res);
        } catch (error) {
            if (error instanceof z.ZodError) {
                res.status(400).json({ message: 'Nieprawidłowe dane testu lub przypisania.' });
                return;
            }
            res.status(503).json({ message: 'Nie udało się wykonać operacji. Sprawdź bazę i połączenie z Planem ZUT.' });
        }
    };

kantechDevRoutes.get('/', api(async (req, res) => {
    const [cards, readers] = await Promise.all([
        attendanceDb.attendanceCard.findMany({ orderBy: { alias: 'asc' } }),
        listReaders(),
    ]);
    res.json({ cards, readers, observed: getObservedAliases(), simulated: getSimulation(owner(req)) });
}));

kantechDevRoutes.post('/cards', auditAction('KANTECH', 'Zapisano przypisanie karty'), api(async (req, res) => {
    const input = mapping.parse(req.body);
    const target = input.role === 'lecturer' ? input.login : input.target;
    const data = {
        alias: normalizeCardAlias(input.alias),
        login: target.toLowerCase(),
        name: input.name ?? target,
        album: input.role === 'participant' && /^\d+$/.test(target) ? target : null,
        scheduleId: input.role === 'lecturer' ? input.scheduleId : null,
    };
    const card = await attendanceDb.attendanceCard.upsert({
        where: { alias: data.alias }, create: data, update: data,
    });
    res.json(card);
}));

kantechDevRoutes.get('/schedule', api(async (req, res) => {
    const teacherId = text.parse(req.query.teacherId);
    res.json(await getTeacherSchedule(teacherId, new Date()));
}));

kantechDevRoutes.post('/scans', attendanceScanRateLimiter, api(async (req, res) => {
    res.json(await simulateScan(owner(req), simulation.parse(req.body)));
}));

kantechDevRoutes.delete('/scans', (req: AuthRequest, res) => {
    resetSimulation(owner(req));
    res.sendStatus(204);
});
