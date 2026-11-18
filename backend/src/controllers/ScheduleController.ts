import { Response } from 'express';
import {ZutServices} from "../services/ZutServices";
import { PrismaClient } from '@prisma/client';
import { AuthRequest } from '../middlewares/authMiddleware';
import { scheduleEventId } from '../attendance/schedule';
import { parseCampusTime } from '../attendance/scheduleTime';
import { env } from '../config/env';

const prisma = new PrismaClient();

const MAX_SCHEDULE_ID_LENGTH = 120;
const ALLOWED_SCHEDULE_KINDS = new Set(['room', 'worker', 'teacher', 'student']);

export const getPlan = async(req: AuthRequest, res: Response) => {
    try {
        const { id, kind, start, end } = req.query;
        
        if (!id) {
            return res.status(400).json({ error: 'Musisz podać ID (np. numer sali)' });
        }

        const normalizedId = String(id).trim();
        const normalizedKind = String(kind ?? 'room').toLowerCase();

        if (!normalizedId || normalizedId.length > MAX_SCHEDULE_ID_LENGTH) {
            return res.status(400).json({ error: 'Nieprawidłowe ID planu.' });
        }

        if (!ALLOWED_SCHEDULE_KINDS.has(normalizedKind)) {
            return res.status(400).json({ error: 'Nieprawidłowy rodzaj planu.' });
        }
        
        const ownPlan = (normalizedKind === 'worker' || normalizedKind === 'teacher')
            && req.user?.displayName.trim().toLowerCase() === normalizedId.toLowerCase();
        const binding = ownPlan ? await prisma.attendanceCard.findFirst({
            where: { login: req.user!.login.trim().toLowerCase(), scheduleId: { not: null } },
            orderBy: { alias: 'asc' },
            select: { scheduleId: true },
        }) : null;
        const service = new ZutServices(binding ? env.ZUT_ATTENDANCE_SCHEDULE_URL : undefined);
        const data = await service.getSchedule(binding?.scheduleId ?? normalizedId, normalizedKind, start as string, end as string);

        // Enrich each event with a stable numeric ID if it doesn't have one
        const enriched = Array.isArray(data)
            ? data.filter((event) => event && !Array.isArray(event) && typeof event === 'object').map((event: any) => ({
                ...event,
                id: scheduleEventId(event),
                attendanceStart: typeof event.start === 'string' ? parseCampusTime(event.start)?.toISOString() : undefined,
            }))
            : data;

        if (Array.isArray(enriched) && enriched.length > 0) {
            const lessonIds = enriched
                .map((event: any) => Number(event.id))
                .filter((id) => !isNaN(id));

            if (lessonIds.length > 0) {
                const messages = await prisma.message.findMany({
                    where: {
                        lessonId: { in: lessonIds },
                    },
                    select: {
                        lessonId: true,
                    },
                });

                const msgLessonIds = new Set(messages.map((m) => m.lessonId));

                enriched.forEach((event: any) => {
                    event.hasNotifications = msgLessonIds.has(Number(event.id));
                });
            }
        }
        
        return res.json(enriched);
    } catch (error) {
        console.error('Error fetching plan:', error);
        return res.status(500).json({error: 'Wystąpił błąd podczas pobierania planu'});
    }
}
