import { createHash } from 'node:crypto';
import { z } from 'zod';
import { normalizeCardAlias } from './cardAlias';

export const incomingScan = z.object({
    key: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    readerId: z.string().trim().min(1).max(64),
    alias: z.string().trim().min(1).max(128),
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
    occurredAt: string | null;
    receivedAt: string;
    outcome: string;
    sourceAlias: string;
}

const events = new Map<string, MonitorEvent>();
const readers = new Map<string, { state: 'connected' | 'unavailable'; checkedAt: string }>();

export function reportReader(readerId: string, state: 'connected' | 'unavailable') {
    readers.set(readerId, { state, checkedAt: new Date().toISOString() });
}

export function forgetReader(readerId: string) {
    readers.delete(readerId);
}

export function reportScan(scan: IncomingScan, outcome: string, assigned = false) {
    const existing = events.get(scan.key);
    if (existing) return;
    const normalized = normalizeCardAlias(scan.alias);
    const label = assigned && /^WISYNC_[0-9]+$/.test(normalized)
        ? normalized
        : '••••' + normalized.slice(-4);
    events.set(scan.key, {
        key: scan.key, readerId: scan.readerId, label,
        occurredAt: scan.occurredAt, receivedAt: new Date().toISOString(), outcome,
        sourceAlias: scan.alias,
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
            .filter((event) => !readerId || event.readerId === readerId).slice(0, limit)
            .map(({ sourceAlias: _sourceAlias, ...event }) => event),
    };
}

export function getObservedAliases() {
    const recent = new Map<string, { alias: string; canonicalAlias: string; readerId: string; receivedAt: string }>();
    for (const { sourceAlias, readerId, receivedAt } of [...events.values()].reverse()) {
        if (/^(?:[0-9a-f]{2,}:)+[0-9a-f]{2,}$/i.test(sourceAlias)) continue;
        const key = JSON.stringify([readerId, sourceAlias]);
        if (!recent.has(key)) {
            recent.set(key, { alias: sourceAlias, canonicalAlias: normalizeCardAlias(sourceAlias), readerId, receivedAt });
        }
    }
    return [...recent.values()].slice(0, 20);
}
