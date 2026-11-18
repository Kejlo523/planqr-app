import { createHash } from 'node:crypto';
import axios from 'axios';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import type { IncomingScan } from './monitor';
import { parseCampusTime } from './scheduleTime';
import { normalizeCardAlias } from './cardAlias';

type XmlNode = Record<string, unknown>;
const isNode = (value: unknown): value is XmlNode => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const loginScheduleRetryMs = 60_000;
const loginScheduleError = 'SmartService operator login is outside its configured schedule';
const parser = new XMLParser({
    parseTagValue: false, processEntities: false,
    isArray: (tag) => tag === 'item',
});

function readXml(text: string): unknown {
    if (/<!DOCTYPE|<!ENTITY/i.test(text) || XMLValidator.validate(text) !== true) {
        throw new Error('Invalid SmartService XML');
    }
    return parser.parse(text);
}

function* findItems(node: unknown): Generator<XmlNode> {
    if (Array.isArray(node)) {
        for (const child of node) yield* findItems(child);
    } else if (isNode(node)) {
        for (const [key, child] of Object.entries(node)) {
            if (key === 'item' && Array.isArray(child)) {
                for (const item of child) if (isNode(item)) yield item;
            } else {
                yield* findItems(child);
            }
        }
    }
}

function findSessionKey(node: unknown): string | undefined {
    if (!isNode(node)) return undefined;
    const direct = node.SessionKey ?? node.Key;
    if (typeof direct === 'string' && direct.trim()) return direct.trim();
    for (const child of Object.values(node)) {
        const key = findSessionKey(child);
        if (key) return key;
    }
    return undefined;
}

export function parseReaderSnapshot(text: string, readerId: string): IncomingScan[] {
    const records: IncomingScan[] = [];
    for (const item of findItems(readXml(text))) {
        const value = item.value;
        const entry = isNode(value) && (value.SmartLinkDataValue ?? value);
        const raw = isNode(entry) && entry.Value;
        if (typeof raw !== 'string') continue;
        const match = /^(\S+)\s+(\S+)\s+(.+?)\s+(\S+)\s+(\S+)$/.exec(raw.trim());
        if (!match) continue;
        const [, date, time, status, card, identity] = match;
        const alias = identity;
        if (alias.length > 128) continue;
        const occurredAt = parseCampusTime(date + 'T' + time)?.toISOString() ?? null;
        // SmartService snapshot keys can depend on the response. Use the event content until the hardware pilot verifies them.
        const key = createHash('sha256').update(JSON.stringify([
            readerId, occurredAt ?? [date, time], status.toLowerCase(), card.toUpperCase(), normalizeCardAlias(alias),
        ])).digest('hex');
        records.push({ key, readerId, alias, occurredAt, granted: /^access granted$/i.test(status) });
    }
    return records.sort((a, b) => (a.occurredAt ?? '').localeCompare(b.occurredAt ?? '') || a.key.localeCompare(b.key));
}

export class SmartService {
    private key: string | undefined;
    private retryLoginAt = 0;

    constructor(private readonly url: string, private readonly username: string, private readonly password: string) {}

    private async request(path: string, params: Record<string, string>) {
        const response = await axios.get<string>(this.url.replace(/\/+$/, '') + '/' + path, {
            params, timeout: 5_000, responseType: 'text', maxRedirects: 0, maxContentLength: 2 * 1024 * 1024,
        });
        return response.data;
    }

    async read(readerId: string) {
        if (!this.key) {
            if (Date.now() < this.retryLoginAt) throw new Error(loginScheduleError);
            const reply = readXml(await this.request('Login', { userName: this.username, password: this.password }));
            if (isNode(reply) && isNode(reply.StandardFault) && typeof reply.StandardFault.Message === 'string'
                && reply.StandardFault.Message.includes('SMARTLINK_INVALID_LOGIN_SCHEDULE')) {
                this.retryLoginAt = Date.now() + loginScheduleRetryMs;
                throw new Error(loginScheduleError);
            }
            this.key = findSessionKey(reply);
            if (!this.key) throw new Error('SmartService refused the session');
        }
        try {
            const xml = await this.request('LastDoorAccess', { sdKey: this.key, id: readerId, accessType: '0' });
            return parseReaderSnapshot(xml, readerId);
        } catch (error) {
            await this.logout().catch(() => undefined);
            throw error;
        }
    }

    async logout() {
        const key = this.key;
        this.key = undefined;
        if (key) await this.request('Logout', { sdKey: key });
    }
}
