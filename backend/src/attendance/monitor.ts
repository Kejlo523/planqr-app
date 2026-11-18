import { createHash } from 'node:crypto';
import { z } from 'zod';

export const incomingScan = z.object({
    key: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    readerId: z.string().trim().min(1).max(64),
    alias: z.string().trim().min(1).max(128).transform((value) => value.toUpperCase()),
    occurredAt: z.string().datetime({ offset: true }).transform((value) => new Date(value).toISOString()).nullable(),
    granted: z.boolean(),
}).transform((scan) => ({
    ...scan,
    key: scan.key ?? createHash('sha256').update(JSON.stringify([
        scan.readerId, scan.alias, scan.occurredAt, scan.granted,
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
    occurredAt: string | null;
    receivedAt: string;
    outcome: string;
}

const events = new Map<string, MonitorEvent>();
const readers = new Map<string, { state: 'connected' | 'unavailable'; checkedAt: string }>();

export function reportReader(readerId: string, state: 'connected' | 'unavailable') {
    readers.set(readerId, { state, checkedAt: new Date().toISOString() });
}

export function reportScan(scan: IncomingScan, outcome: string, assigned = false) {
    const existing = events.get(scan.key);
    if (existing) return;
    const label = assigned && /^WISYNC_[0-9]+$/i.test(scan.alias)
        ? scan.alias
        : '••••' + scan.alias.slice(-4);
    events.set(scan.key, {
        key: scan.key, readerId: scan.readerId, label,
        occurredAt: scan.occurredAt, receivedAt: new Date().toISOString(), outcome,
    });
    const oldest = events.keys().next().value;
    if (events.size > 100 && oldest) events.delete(oldest);
}

export function updateScanOutcome(key: string, outcome: string) {
    const event = events.get(key);
    if (event) event.outcome = outcome;
}

export function getMonitor(readerId?: string, limit = 100) {
    return {
        readers: Array.from(readers, ([id, info]) => ({ id, ...info }))
            .filter(({ id }) => !readerId || id === readerId),
        events: [...events.values()].reverse()
            .filter((event) => !readerId || event.readerId === readerId).slice(0, limit),
    };
}
