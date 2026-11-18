import { setTimeout as delay } from 'node:timers/promises';
import axios from 'axios';
import { z } from 'zod';
import type { IncomingScan } from './monitor';
import { SmartService } from './smartService';

const config = z.object({
    KANTECH_URL: z.string().url(),
    KANTECH_USER: z.string().min(1),
    KANTECH_PASS: z.string().min(1),
    KANTECH_POLL_INTERVAL_MS: z.coerce.number().int().min(500).max(60_000).default(1_000),
    KANTECH_REPORT_URL: z.string().url(),
    WORKER_SECRET_TOKEN: z.string().min(1),
});

type Reader = {
    acknowledged: Set<string>;
    pending: Map<string, IncomingScan>;
    lastReport: number;
    state?: 'connected' | 'unavailable';
};

const readerConfiguration = z.object({ readerIds: z.array(z.string().min(1).max(64)) });
const refreshInterval = 3_000;

async function main() {
    const parsed = config.safeParse(process.env);
    if (!parsed.success) throw new Error('Invalid Kantech worker configuration');
    const settings = parsed.data;
    const source = new SmartService(settings.KANTECH_URL, settings.KANTECH_USER, settings.KANTECH_PASS);
    const abort = new AbortController();
    process.once('SIGTERM', () => abort.abort());
    process.once('SIGINT', () => abort.abort());
    const readers = new Map<string, Reader>();
    const headers = { Authorization: 'Bearer ' + settings.WORKER_SECRET_TOKEN };
    const readersUrl = settings.KANTECH_REPORT_URL.replace(/\/+$/, '') + '/readers';
    let refreshAt = 0;

    try {
        while (!abort.signal.aborted) {
            let failed = false;
            if (Date.now() >= refreshAt) {
                try {
                    const response = await axios.get(readersUrl, {
                        headers, timeout: 5_000, maxRedirects: 0, signal: abort.signal,
                    });
                    const ids = new Set(readerConfiguration.parse(response.data).readerIds);
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
                    await axios.post(settings.KANTECH_REPORT_URL, { readerId, state, events }, {
                        timeout: 25_000,
                        maxRedirects: 0,
                        headers,
                        signal: abort.signal,
                    });
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
        await source.logout().catch(() => undefined);
    }
}

void main().catch(() => {
    console.error('[Kantech] Worker startup failed.');
    process.exitCode = 1;
});
