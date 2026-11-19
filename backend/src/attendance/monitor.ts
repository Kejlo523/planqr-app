import { createHash } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { normalizeCardAlias } from './cardAlias';

export const incomingScan = z.object({
    key: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    readerId: z.string().trim().min(1).max(64),
    alias: z.string().trim().min(1).max(128).refine((alias) => !alias.includes('\0')),
    occurredAt: z.string().datetime({ offset: true }).transform((value) => new Date(value).toISOString()).nullable(),
    granted: z.boolean(),
}).transform((scan) => ({
    ...scan,
    key: scan.key ?? createHash('sha256').update(JSON.stringify([
        scan.readerId, normalizeCardAlias(scan.alias), scan.occurredAt, scan.granted,
    ])).digest('hex'),
}));

export const workerReport = z.object({
    readerId: z.string().trim().min(1).max(64),
    state: z.enum(['connected', 'unavailable']),
    events: z.array(incomingScan).max(100),
}).refine((report) => report.events.every((event) => event.readerId === report.readerId));

export const incomingReport = z.union([
    workerReport,
    incomingScan.transform((scan) => ({ readerId: scan.readerId, state: 'connected' as const, events: [scan] })),
]);

export type IncomingScan = z.infer<typeof incomingScan>;

interface MonitorEvent {
    key: string;
    readerId: string;
    label: string;
    occurredAt: Date | null;
    receivedAt: Date;
    outcome: string;
}

export async function getMonitor(database: PrismaClient, readerId?: string, limit = 100) {
    const [readers, events] = await Promise.all([
        database.kantechReaderStatus.findMany({ where: { readerId }, orderBy: { readerId: 'asc' } }),
        database.$queryRaw<MonitorEvent[]>`
            SELECT id AS key, alias AS label, "readerId", "occurredAt", "receivedAt", outcome
            FROM "KantechReadings"
            ${readerId === undefined ? Prisma.empty : Prisma.sql`WHERE "readerId" = ${readerId}`}
            ORDER BY "receivedAt" DESC, id DESC LIMIT ${limit}
        `,
    ]);
    return {
        readers: readers.map(({ readerId: id, ...status }) => ({ id, ...status })),
        events,
    };
}

export async function getObservedAliases(database: PrismaClient) {
    const events = await database.kantechEvent.findMany({
        orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }], take: 100,
        select: { alias: true, readerId: true, receivedAt: true },
    });
    const recent = new Map<string, typeof events[number] & { canonicalAlias: string }>();
    for (const event of events) {
        if (/^(?:[0-9a-f]{2,}:)+[0-9a-f]{2,}$/i.test(event.alias)) continue;
        const key = JSON.stringify([event.readerId, event.alias]);
        if (!recent.has(key)) {
            recent.set(key, { ...event, canonicalAlias: normalizeCardAlias(event.alias) });
        }
    }
    return [...recent.values()].slice(0, 20);
}
