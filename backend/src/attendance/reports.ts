import type { KantechCaptureMode, PrismaClient } from '@prisma/client';
import type { incomingReport } from './monitor';
import type { z } from 'zod';
import { readCaptureSettings } from './captureSettings';

export type ReaderReport = z.infer<typeof incomingReport>;

export async function saveReaderReport(
    database: PrismaClient, report: ReaderReport, defaultMode: KantechCaptureMode, registeredOnly: boolean,
) {
    await database.$transaction(async (tx) => {
        const { readerId, state, events } = report;
        const reader = await tx.attendanceReader.findUnique({ where: { id: readerId }, select: { id: true } });
        if (!reader && registeredOnly) return;
        if (reader) {
            const checkedAt = new Date();
            await tx.kantechReaderStatus.upsert({
                where: { readerId }, create: { readerId, state, checkedAt }, update: { state, checkedAt },
            });
        }
        if (events.length) {
            const settings = await readCaptureSettings(tx);
            await tx.kantechEvent.createMany({
                data: events.map(({ key, alias, occurredAt, granted }) => ({
                    id: key, readerId, alias, granted,
                    captureMode: settings?.mode ?? defaultMode,
                    captureActiveFrom: settings?.activeFrom ?? null,
                    occurredAt: occurredAt ? new Date(occurredAt) : null,
                })),
                skipDuplicates: true,
            });
        }
    });
}
