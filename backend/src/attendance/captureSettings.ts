import { KantechCaptureMode, type Prisma, type PrismaClient } from '@prisma/client';
import { z } from 'zod';

export const captureSettingsInput = z.object({ mode: z.nativeEnum(KantechCaptureMode) });

export function readCaptureSettings(database: Prisma.TransactionClient) {
    return database.kantechCaptureSettings.findUnique({
        where: { id: 1 }, select: { mode: true, activeFrom: true },
    });
}

export function updateCaptureSettings(database: PrismaClient, mode: KantechCaptureMode) {
    return database.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('planqr:kantech-mode', 0))`;
        const current = await readCaptureSettings(tx);
        if (current?.mode === mode) return current;

        const setting = { mode, activeFrom: mode === 'attendance' ? new Date() : null };
        return tx.kantechCaptureSettings.upsert({
            where: { id: 1 }, create: { id: 1, ...setting }, update: setting,
            select: { mode: true, activeFrom: true },
        });
    });
}
