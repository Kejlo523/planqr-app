import { setTimeout as delay } from 'node:timers/promises';
import { PrismaClient } from '@prisma/client';
import axios from 'axios';
import { z } from 'zod';
import type { IncomingScan } from './monitor';
import { saveReaderReport, type ReaderReport } from './reports';
import { saveInventory, type InventoryReaders } from './inventory';
import { SmartService } from './smartService';

const coreConfig = {
    KANTECH_URL: z.string().url(),
    KANTECH_USER: z.string().min(1),
    KANTECH_PASS: z.string().min(1),
    KANTECH_POLL_INTERVAL_MS: z.coerce.number().int().min(500).max(60_000).default(1_000),
};
const config = z.discriminatedUnion('KANTECH_TRANSPORT', [
    z.object({
        ...coreConfig, KANTECH_TRANSPORT: z.literal('http'),
        KANTECH_REPORT_URL: z.string().url(), WORKER_SECRET_TOKEN: z.string().min(1),
    }),
    z.object({
        ...coreConfig, KANTECH_TRANSPORT: z.literal('postgres'),
        KANTECH_DATABASE_URL: z.string().url().regex(/^postgres(?:ql)?:\/\//),
        KANTECH_MODE: z.enum(['observe', 'attendance']),
    }),
]);

type Reader = {
    acknowledged: Set<string>;
    pending: Map<string, IncomingScan>;
    lastReport: number;
    state?: 'connected' | 'unavailable';
};

const readerConfiguration = z.object({ readerIds: z.array(z.string().min(1).max(64)) });
const refreshInterval = 3_000;
const inventoryInterval = 60_000;

function createTransport(settings: z.infer<typeof config>, signal: AbortSignal) {
    if (settings.KANTECH_TRANSPORT === 'postgres') {
        const database = new PrismaClient({ datasourceUrl: settings.KANTECH_DATABASE_URL });
        return {
            readerIds: async () => (await database.attendanceReader.findMany({
                select: { id: true }, orderBy: { id: 'asc' },
            })).map(({ id }) => id),
            send: (report: ReaderReport) => saveReaderReport(database, report, settings.KANTECH_MODE, true),
            inventory: (readers: InventoryReaders) => saveInventory(database, readers),
            close: () => database.$disconnect(),
        };
    }
    const headers = { Authorization: 'Bearer ' + settings.WORKER_SECRET_TOKEN };
    const reportUrl = settings.KANTECH_REPORT_URL.replace(/\/+$/, '');
    return {
        readerIds: async () => {
            const response = await axios.get(reportUrl + '/readers', { headers, timeout: 5_000, maxRedirects: 0, signal });
            return readerConfiguration.parse(response.data).readerIds;
        },
        send: async (report: ReaderReport) => {
            await axios.post(reportUrl, report, { headers, timeout: 25_000, maxRedirects: 0, signal });
        },
        inventory: async (readers: InventoryReaders) => {
            await axios.post(reportUrl + '/inventory', readers, { headers, timeout: 5_000, maxRedirects: 0, signal });
        },
    };
}

async function main() {
    const parsed = config.safeParse({ ...process.env, KANTECH_TRANSPORT: process.env.KANTECH_TRANSPORT ?? 'http' });
    if (!parsed.success) throw new Error('Invalid Kantech worker configuration');
    const settings = parsed.data;
    const source = new SmartService(settings.KANTECH_URL, settings.KANTECH_USER, settings.KANTECH_PASS);
    const abort = new AbortController();
    process.once('SIGTERM', () => abort.abort());
    process.once('SIGINT', () => abort.abort());
    const readers = new Map<string, Reader>();
    const transport = createTransport(settings, abort.signal);
    let refreshAt = 0;
    let inventoryAt = 0;
    let inventoryTask: Promise<void> | undefined;
    let inventoryFailed = false;

    try {
        while (!abort.signal.aborted) {
            if (!inventoryTask && Date.now() >= inventoryAt) {
                inventoryTask = source.readInventory(abort.signal).then(async (items) => {
                    if (abort.signal.aborted) return;
                    await transport.inventory(items);
                    inventoryFailed = false;
                }).catch(() => {
                    if (!inventoryFailed && !abort.signal.aborted) console.warn('[Kantech] Reader inventory could not be refreshed.');
                    inventoryFailed = true;
                }).finally(() => {
                    inventoryAt = Date.now() + (inventoryFailed ? 10_000 : inventoryInterval);
                    inventoryTask = undefined;
                });
            }
            let failed = false;
            if (Date.now() >= refreshAt) {
                try {
                    const ids = new Set(await transport.readerIds());
                    for (const id of readers.keys()) {
                        if (!ids.has(id)) readers.delete(id);
                    }
                    for (const id of ids) {
                        if (!readers.has(id)) readers.set(id, { acknowledged: new Set(), pending: new Map(), lastReport: 0 });
                    }
                } catch {
                    failed = true;
                }
                refreshAt = Date.now() + refreshInterval;
            }
            for (const [readerId, reader] of readers) {
                if (abort.signal.aborted) break;
                let state: 'connected' | 'unavailable' = 'connected';
                try {
                    for (const event of await source.read(readerId)) {
                        if (!reader.acknowledged.has(event.key)) reader.pending.set(event.key, event);
                    }
                } catch {
                    state = 'unavailable';
                    failed = true;
                }
                const events = [...reader.pending.values()].slice(0, 75);
                if (!events.length && reader.state === state && Date.now() - reader.lastReport < 10_000) continue;
                try {
                    await transport.send({ readerId, state, events });
                    for (const event of events) {
                        reader.pending.delete(event.key);
                        reader.acknowledged.add(event.key);
                    }
                    while (reader.acknowledged.size > 5_000) {
                        reader.acknowledged.delete(reader.acknowledged.values().next().value!);
                    }
                    reader.state = state;
                    reader.lastReport = Date.now();
                } catch {
                    failed = true;
                }
            }
            await delay(failed ? Math.max(settings.KANTECH_POLL_INTERVAL_MS, 5_000) : settings.KANTECH_POLL_INTERVAL_MS,
                undefined, { signal: abort.signal }).catch(() => undefined);
        }
    } finally {
        await inventoryTask;
        await Promise.allSettled([source.logout(), transport.close?.()]);
    }
}

void main().catch(() => {
    console.error('[Kantech] Worker startup failed.');
    process.exitCode = 1;
});
