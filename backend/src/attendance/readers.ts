import { z } from 'zod';
import { Prisma, ReaderDirection } from '@prisma/client';
import { env } from '../config/env';
import { normalizeRoom } from './schedule';
import { attendanceDb, lockReaderConfiguration } from './store';

export const readerIdSchema = z.string().trim().min(1).max(64)
    .refine((id) => !id.includes('\0'), 'Nieprawidłowe ID czytnika.');
const roomField = z.string().trim().max(128).default('');
const readerName = z.string().trim().min(1).max(128);

export const readerInput = z.object({
    id: readerIdSchema,
    label: readerName,
    buildingId: roomField,
    roomNumber: roomField,
    direction: z.nativeEnum(ReaderDirection).nullable().optional(),
    pairedReaderId: readerIdSchema.nullable().optional(),
}).transform((reader) => ({
    ...reader,
    buildingId: normalizeRoom(reader.buildingId),
    roomNumber: normalizeRoom(reader.roomNumber),
}));

const readerEndpoint = z.object({ id: readerIdSchema, label: readerName });
export const readerSetupInput = z.object({
    entry: readerEndpoint,
    exit: readerEndpoint.nullable(),
    buildingId: roomField,
    roomNumber: roomField,
    edit: z.boolean().default(false),
}).refine(({ entry, exit }) => entry.id !== exit?.id, {
    message: 'Wejście i wyjście muszą mieć różne ID. Dla jednego urządzenia wybierz tryb jednego czytnika.',
});

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

export async function saveReader(input: z.infer<typeof readerInput>) {
    await ensureReaderSetup();
    return attendanceDb.$transaction(async (tx) => {
        await lockReaderConfiguration(tx);
        const { id, pairedReaderId, direction, ...location } = input;
        const current = await tx.attendanceReader.findUnique({ where: { id }, select: readerFields });
        const oldPeer = current?.exitReaderId ?? current?.entryReader?.id ?? null;
        const nextDirection = direction === undefined ? current?.direction ?? null : direction;
        const nextPeer = pairedReaderId === undefined ? oldPeer : pairedReaderId;
        if (nextPeer === id) throw new ReaderConfigurationError('Wybierz drugi czytnik do pary.');
        const peer = nextPeer ? await tx.attendanceReader.findUnique({
            where: { id: nextPeer }, select: readerFields,
        }) : null;
        if (current?.groupId || peer?.groupId) {
            throw new ReaderConfigurationError('Zmień konfigurację w grupie urządzeń RCP.');
        }
        if ((current?.singleReader && (nextPeer || nextDirection !== 'ENTRY')) || peer?.singleReader) {
            throw new ReaderConfigurationError('Czytnik działający w obie strony zmień w konfiguracji wejścia i wyjścia.');
        }
        if (nextPeer && (!peer?.direction || !nextDirection || peer.direction === nextDirection)) {
            throw new ReaderConfigurationError('Para musi zawierać różne czytniki: wejście i wyjście.');
        }
        if (peer && [peer.exitReaderId, peer.entryReader?.id].some((partner) => partner && partner !== id)) {
            throw new ReaderConfigurationError('Drugi czytnik należy już do innej pary.');
        }
        if (current && (nextDirection !== current.direction || nextPeer !== oldPeer)) {
            await requireIdleReaders(tx, [id, ...(oldPeer ? [oldPeer] : []), ...(nextPeer ? [nextPeer] : [])]);
        }
        if (current?.entryReader && (nextDirection !== 'EXIT' || nextPeer !== oldPeer)) {
            await tx.attendanceReader.update({
                where: { id: current.entryReader.id }, data: { exitReaderId: null },
            });
        }
        const data = {
            ...location, direction: nextDirection, exitReaderId: nextDirection === 'ENTRY' ? nextPeer : null,
        };
        await tx.attendanceReader.upsert({ where: { id }, create: { id, ...data }, update: data });
        if (nextDirection === 'EXIT' && peer) {
            await tx.attendanceReader.update({ where: { id: peer.id }, data: { exitReaderId: id } });
        }
        return readerView(await tx.attendanceReader.findUniqueOrThrow({ where: { id }, select: readerFields }));
    });
}

export async function saveReaderSetup({ entry, exit, buildingId, roomNumber, edit }: z.infer<typeof readerSetupInput>) {
    await ensureReaderSetup();
    const location = { buildingId: normalizeRoom(buildingId), roomNumber: normalizeRoom(roomNumber) };
    return attendanceDb.$transaction(async (tx) => {
        await lockReaderConfiguration(tx);
        const existing = await tx.attendanceReader.findMany({
            where: { id: { in: exit ? [entry.id, exit.id] : [entry.id] } }, select: readerFields,
        });
        const currentEntry = existing.find(({ id }) => id === entry.id);
        const currentExit = existing.find(({ id }) => id === exit?.id);
        if (existing.some(({ groupId }) => groupId !== null)) {
            throw new ReaderConfigurationError('Zmień konfigurację w grupie urządzeń RCP.');
        }
        if (!edit && existing.length) {
            throw new ReaderConfigurationError('To ID jest już zapisane. Wybierz Edytuj przy istniejącym czytniku.');
        }
        if (edit && (!currentEntry || currentEntry.entryReader)) {
            throw new ReaderConfigurationError('Otwórz konfigurację od strony wejścia.');
        }
        if (currentExit && (currentExit.direction === 'ENTRY' ||
            (currentExit.entryReader && currentExit.entryReader.id !== entry.id))) {
            throw new ReaderConfigurationError('Wybrany czytnik jest już skonfigurowany w innej roli lub parze.');
        }

        const exitReaderId = exit?.id ?? null;
        const singleReader = !exit;
        if (currentEntry && (currentEntry.exitReaderId !== exitReaderId || currentEntry.singleReader !== singleReader ||
            currentEntry.direction !== 'ENTRY')) {
            const affected = [entry.id, currentEntry.exitReaderId, exitReaderId].filter((id): id is string => id !== null);
            await requireIdleReaders(tx, affected);
        }

        if (exit) {
            const data = { ...location, label: exit.label, direction: ReaderDirection.EXIT };
            await tx.attendanceReader.upsert({ where: { id: exit.id }, create: { id: exit.id, ...data }, update: data });
        }
        const data = { ...location, label: entry.label, direction: ReaderDirection.ENTRY, singleReader, exitReaderId };
        const saved = await tx.attendanceReader.upsert({
            where: { id: entry.id }, create: { id: entry.id, ...data }, update: data, select: readerFields,
        });
        return readerView(saved);
    });
}

export async function deleteReader(id: string) {
    await ensureReaderSetup();
    await attendanceDb.$transaction(async (tx) => {
        await lockReaderConfiguration(tx);
        if (await tx.attendanceReader.findFirst({ where: { id, groupId: { not: null } } })) {
            throw new ReaderConfigurationError('Usuń urządzenie z grupy RCP.');
        }
        await requireIdleReaders(tx, [id]);
        await tx.attendanceReader.deleteMany({ where: { id } });
    });
}
