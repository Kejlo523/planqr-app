import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { env } from '../config/env';
import { attendanceDb } from './store';

export const readerIdSchema = z.string().trim().min(1).max(64)
    .refine((id) => !id.includes('\0'), 'Nieprawidłowe ID czytnika.');
let initialSetup: Promise<void> | undefined;

export function ensureReaderSetup() {
    initialSetup ??= attendanceDb.$transaction(async (database) => {
        const marker = await database.kantechReaderSetup.createMany({ data: [{ id: 1 }], skipDuplicates: true });
        if (!marker.count || !env.KANTECH_DOOR_IDS.length || await database.attendanceReader.count()) return;
        await database.attendanceReader.createMany({
            data: env.KANTECH_DOOR_IDS.map((id) => ({ id, label: 'Czytnik ' + id, buildingId: '', roomNumber: '' })),
            skipDuplicates: true,
        });
    }).catch((error) => {
        initialSetup = undefined;
        throw error;
    });
    return initialSetup;
}

export async function listReaders() {
    await ensureReaderSetup();
    const readers = await attendanceDb.attendanceReader.findMany({
        orderBy: { id: 'asc' }, select: readerFields,
    });
    return readers.map(readerView);
}

const readerFields = {
    id: true, label: true, buildingId: true, roomNumber: true, direction: true,
    singleReader: true, exitReaderId: true, entryReader: { select: { id: true } }, groupId: true,
} satisfies Prisma.AttendanceReaderSelect;

const readerView = ({ exitReaderId, entryReader, ...reader }:
    Prisma.AttendanceReaderGetPayload<{ select: typeof readerFields }>) => ({
    ...reader, pairedReaderId: exitReaderId ?? entryReader?.id ?? null,
});

export class ReaderConfigurationError extends Error {}

export async function requireIdleReaders(tx: Prisma.TransactionClient, ids: string[], groupId?: number) {
    const session = await tx.attendanceSession.findFirst({
        where: {
            voided: false,
            AND: [
                { OR: [{ closesAt: null }, { closesAt: { gt: new Date() } }] },
                { OR: [{ readerId: { in: ids } }, { exitReaderId: { in: ids } },
                    ...(groupId === undefined ? [] : [{ roomKey: `group:${groupId}` }])] },
            ],
        }, select: { id: true },
    });
    if (session) throw new ReaderConfigurationError('Najpierw zamknij aktywną listę obecności na czytniku wyjściowym.');
}
