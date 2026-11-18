import { AuditCategory } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';
import { requireAdmin, type AuthRequest } from '../middlewares/authMiddleware';
import { listAuditEvents, updateAuditRetention } from '../services/auditLogService';

const router = Router();
router.use(requireAdmin, (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
});

const page = z.object({
    limit: z.coerce.number().int().min(1).max(200).default(50),
    before: z.coerce.number().int().min(1).max(2_147_483_647).optional(),
    category: z.nativeEnum(AuditCategory).optional(),
    query: z.string().trim().max(100).optional(),
});

router.get('/', async (req, res) => {
    const filters = page.safeParse(req.query);
    if (!filters.success) {
        res.status(400).json({ message: 'Nieprawidłowe filtry logów.' });
        return;
    }
    try {
        res.json(await listAuditEvents(filters.data));
    } catch {
        res.status(503).json({ message: 'Nie udało się pobrać logów.' });
    }
});

const retention = z.object({ days: z.number().int().min(1).max(365) });

router.put('/retention', async (req: AuthRequest, res) => {
    const input = retention.safeParse(req.body);
    if (!input.success) {
        res.status(400).json({ message: 'Podaj liczbę dni od 1 do 365.' });
        return;
    }
    try {
        res.json(await updateAuditRetention(input.data.days, req.user!.login));
    } catch {
        res.status(503).json({ message: 'Nie udało się zapisać okresu przechowywania.' });
    }
});

export default router;
