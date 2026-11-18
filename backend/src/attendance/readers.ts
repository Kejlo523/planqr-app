import { z } from 'zod';
import { env } from '../config/env';
import { normalizeRoom } from './schedule';
import { attendanceDb } from './store';

export const readerIdSchema = z.string().trim().min(1).max(64)
    .refine((id) => !id.includes('\0'), 'Nieprawidłowe ID czytnika.');
const roomField = z.string().trim().max(128).default('');

export const readerInput = z.object({
    id: readerIdSchema,
    label: z.string().trim().min(1).max(128),
    buildingId: roomField,
    roomNumber: roomField,
}).refine(({ buildingId, roomNumber }) => Boolean(buildingId) === Boolean(roomNumber), {
    message: 'Podaj budynek i salę albo zostaw oba pola puste.',
}).transform((reader) => ({
    ...reader,
    buildingId: normalizeRoom(reader.buildingId),
    roomNumber: normalizeRoom(reader.roomNumber),
}));

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
    return attendanceDb.attendanceReader.findMany({ orderBy: { id: 'asc' } });
}
