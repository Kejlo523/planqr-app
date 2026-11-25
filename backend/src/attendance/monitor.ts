import { createHash } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { normalizeCardAlias } from './cardAlias';
import type { listKantechDevices } from './readerGroups';

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

interface MonitorFilters {
    readerId?: string;
    deviceId?: string;
    search?: string;
    outcome?: string;
    from?: Date;
    before?: Date;
    limit?: number;
}

export async function getMonitor(
    database: PrismaClient, devices: Awaited<ReturnType<typeof listKantechDevices>>, filters: MonitorFilters,
) {
    const { readerId, deviceId, search, outcome, from, before, limit = 100 } = filters;
    const deviceReaders = new Map(devices.flatMap((device) => device.readers.map((reader) =>
        [reader.id, { deviceId: device.id, readerLabel: reader.label, role: reader.role }] as const)));
    const conditions: Prisma.Sql[] = [];
    if (readerId) conditions.push(Prisma.sql`"readerId" = ${readerId}`);
    if (deviceId) {
        const ids = devices.find(({ id }) => id === deviceId)?.readers.map(({ id }) => id) ?? [];
        conditions.push(ids.length ? Prisma.sql`"readerId" IN (${Prisma.join(ids)})` : Prisma.sql`FALSE`);
    }
    if (outcome) conditions.push(Prisma.sql`outcome = ${outcome}`);
    if (from) conditions.push(Prisma.sql`COALESCE("occurredAt", "receivedAt") >= ${from}`);
    if (before) conditions.push(Prisma.sql`COALESCE("occurredAt", "receivedAt") < ${before}`);
    if (search) {
        const term = search.toLowerCase();
        const matchingReaders = [...deviceReaders].filter(([, reader]) =>
            reader.deviceId.toLowerCase().includes(term) || reader.readerLabel?.toLowerCase().includes(term))
            .map(([id]) => id);
        conditions.push(Prisma.sql`(
            strpos(lower(alias), ${term}) > 0 OR strpos(lower("readerId"), ${term}) > 0
            ${matchingReaders.length ? Prisma.sql`OR "readerId" IN (${Prisma.join(matchingReaders)})` : Prisma.empty}
        )`);
    }
    const [readers, events] = await Promise.all([
        database.kantechReaderStatus.findMany({ orderBy: { readerId: 'asc' } }),
        database.$queryRaw<MonitorEvent[]>`
            SELECT id AS key, alias AS label, "readerId", "occurredAt", "receivedAt", outcome
            FROM "KantechReadings"
            ${conditions.length ? Prisma.sql`WHERE ${Prisma.join(conditions, ' AND ')}` : Prisma.empty}
            ORDER BY "receivedAt" DESC, id DESC LIMIT ${limit}
        `,
    ]);
    return {
        readers: readers.filter((item) => !readerId || item.readerId === readerId)
            .map(({ readerId: id, ...status }) => ({ id, ...status, ...deviceReaders.get(id) })),
        readerIds: readers.map((item) => item.readerId),
        events: events.map((event) => ({ ...event, ...deviceReaders.get(event.readerId) })),
        devices,
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
