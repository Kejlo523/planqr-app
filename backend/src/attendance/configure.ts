import { readFile } from 'node:fs/promises';
import { PrismaClient, ReaderDirection } from '@prisma/client';
import { z } from 'zod';
import { normalizeRoom } from './schedule';
import { normalizeCardAlias } from './cardAlias';

const text = z.string().trim().min(1).max(128);
const configuration = z.object({
    readers: z.array(z.object({
        id: text.max(64), buildingId: text, roomNumber: text, label: text,
        direction: z.nativeEnum(ReaderDirection).optional(), exitReaderId: text.max(64).optional(),
    })),
    cards: z.array(z.object({
        alias: text, login: text, name: text, scheduleId: text.optional(), album: text.optional(),
    })),
});

async function main() {
    const file = process.argv[2];
    if (!file) throw new Error('Pass the path to the reader and card assignments');
    const values = configuration.parse(JSON.parse(await readFile(file, 'utf8')));
    const prisma = new PrismaClient();
    try {
        await prisma.$transaction([
            ...(values.readers.length ? [prisma.kantechReaderSetup.upsert({
                where: { id: 1 }, create: { id: 1 }, update: {},
            })] : []),
            ...values.readers.map(({ exitReaderId: _exit, ...reader }) => {
                const data = { ...reader, buildingId: normalizeRoom(reader.buildingId), roomNumber: normalizeRoom(reader.roomNumber) };
                return prisma.attendanceReader.upsert({ where: { id: reader.id }, create: data, update: data });
            }),
            ...values.readers.flatMap(({ id, exitReaderId }) => exitReaderId ? [
                prisma.attendanceReader.update({ where: { id }, data: { exitReaderId } }),
            ] : []),
            ...values.cards.map((card) => {
                const data = {
                    ...card, alias: normalizeCardAlias(card.alias), login: card.login.toLowerCase(),
                    scheduleId: card.scheduleId ?? null, album: card.album ?? null,
                };
                return prisma.attendanceCard.upsert({ where: { alias: data.alias }, create: data, update: data });
            }),
        ]);
        console.log('Loaded', values.readers.length, 'readers and', values.cards.length, 'card assignments.');
    } finally {
        await prisma.$disconnect();
    }
}

void main().catch(() => {
    console.error('Could not load attendance assignments. Verify the JSON and database settings.');
    process.exitCode = 1;
});
