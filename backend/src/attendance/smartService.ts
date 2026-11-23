import { createHash } from 'node:crypto';
import axios from 'axios';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import type { IncomingScan } from './monitor';
import { parseCampusTime } from './scheduleTime';
import { normalizeCardAlias } from './cardAlias';
import { inventoryDoor, type InventoryDoor, type InventoryReaders } from './inventory';

type XmlNode = Record<string, unknown>;
const isNode = (value: unknown): value is XmlNode => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const loginScheduleRetryMs = 60_000;
const loginScheduleError = 'SmartService operator login is outside its configured schedule';
const doorIdFields = ['id', 'doorid', 'componentid', 'referenceid', 'pkdata'];
const doorLabelFields = ['description', 'name', 'label', 'doordescription', 'doorname'];
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

function* xmlNodes(value: unknown): Generator<XmlNode> {
    if (Array.isArray(value)) {
        for (const child of value) yield* xmlNodes(child);
    } else if (isNode(value)) {
        yield value;
        for (const child of Object.values(value)) yield* xmlNodes(child);
    }
}

function field(node: XmlNode, ...names: string[]) {
    for (const [key, value] of Object.entries(node)) {
        const name = key.slice(key.lastIndexOf(':') + 1).toLowerCase();
        if (typeof value === 'string' && names.includes(name) && value.trim()) return value.trim();
    }
    return undefined;
}

function inventoryXml(text: string) {
    const xml = readXml(text);
    if (isNode(xml) && isNode(xml.StandardFault)) {
        throw new Error(field(xml.StandardFault, 'message')?.match(/\bSMARTLINK_[A-Z_]+\b/)?.[0] ?? 'SmartService inventory fault');
    }
    return xml;
}

export function parseSmartServiceDoors(text: string): InventoryDoor[] {
    const xml = inventoryXml(text);
    const doors = new Map<string, InventoryDoor>();
    const add = (id: string | undefined, label?: string) => {
        const parsed = inventoryDoor.safeParse({ id, label: label?.slice(0, 256) ?? null });
        if (parsed.success && (!doors.has(parsed.data.id) || parsed.data.label)) doors.set(parsed.data.id, parsed.data);
    };
    for (const node of xmlNodes(xml)) {
        const id = field(node, ...doorIdFields) ?? field(node, 'key');
        if (id) add(id, field(node, ...doorLabelFields) ?? field(node, 'value'));
    }
    for (const item of findItems(xml)) {
        const key = typeof item.key === 'string' ? item.key : isNode(item.key) ? field(item.key, 'string', 'int') : undefined;
        const value = isNode(item.value) ? item.value.SmartLinkDataValue ?? item.value : item.value;
        if (isNode(value)) {
            add(field(value, ...doorIdFields) ?? key, field(value, ...doorLabelFields) ?? field(value, 'value', 'string'));
        } else if (typeof value === 'string') {
            add(key, value);
        }
    }
    const root = isNode(xml) && Object.entries(xml).find(([key]) => key !== '?xml');
    if (!doors.size && (!root || !/^(?:\w+:)?(?:arrayof\w+|doors)$/i.test(root[0]) || root[1] !== '')) {
        throw new Error('Unrecognized SmartService doors response');
    }
    return [...doors.values()].sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }));
}

export function parseSmartServiceDoorState(text: string): InventoryReaders[number]['state'] {
    let online = false;
    let offline = false;
    let disabled = false;
    for (const node of xmlNodes(inventoryXml(text))) {
        const failure = field(node, 'controllerfailure', 'communicationfailure')?.toLowerCase();
        const readerDisabled = field(node, 'readerdisable', 'readerdisabled')?.toLowerCase();
        const status = field(node, 'status')?.toLowerCase() ?? '';
        const communication = field(node, 'communicationstate', 'communicationstatus')?.toLowerCase() ?? status;
        offline ||= failure === 'yes' || failure === 'true'
            || /^(?:(?:device|reader|controller) )?(?:offline|not ?connected|disconnected|communication (?:failed|failure))$/.test(communication);
        online ||= failure === 'no' || failure === 'false'
            || /^(?:(?:device|reader|controller) )?(?:online|connected|communication restored)$/.test(communication);
        disabled ||= readerDisabled === 'yes' || readerDisabled === 'true' || /^(?:reader (?:is )?disabled|disabled)$/.test(status ?? '');
    }
    if (offline) return 'offline';
    if (disabled) return 'disabled';
    return online ? 'online' : 'unknown';
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
        if (alias.length > 128 || alias.includes('\0')) continue;
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
    private loginRequest: Promise<string> | undefined;
    private retryLoginAt = 0;

    constructor(private readonly url: string, private readonly username: string, private readonly password: string) {}

    private async request(path: string, params: Record<string, string>, signal?: AbortSignal) {
        const response = await axios.get<string>(this.url.replace(/\/+$/, '') + '/' + path, {
            params, signal, timeout: 5_000, responseType: 'text', maxRedirects: 0, maxContentLength: 2 * 1024 * 1024,
        });
        return response.data;
    }

    private async login() {
        if (Date.now() < this.retryLoginAt) throw new Error(loginScheduleError);
        const reply = readXml(await this.request('Login', { userName: this.username, password: this.password }));
        if (isNode(reply) && isNode(reply.StandardFault) && typeof reply.StandardFault.Message === 'string'
            && reply.StandardFault.Message.includes('SMARTLINK_INVALID_LOGIN_SCHEDULE')) {
            this.retryLoginAt = Date.now() + loginScheduleRetryMs;
            throw new Error(loginScheduleError);
        }
        this.key = findSessionKey(reply);
        if (!this.key) throw new Error('SmartService refused the session');
        return this.key;
    }

    private async session() {
        if (this.key) return this.key;
        this.loginRequest ??= this.login().finally(() => { this.loginRequest = undefined; });
        return this.loginRequest;
    }

    async read(readerId: string) {
        const key = await this.session();
        try {
            const xml = await this.request('LastDoorAccess', { sdKey: key, id: readerId, accessType: '0' });
            return parseReaderSnapshot(xml, readerId);
        } catch (error) {
            await this.logout(key).catch(() => undefined);
            throw error;
        }
    }

    async readInventory(signal: AbortSignal): Promise<InventoryReaders> {
        const key = await this.session();
        const params = { sdKey: key };
        let doors: InventoryDoor[];
        try {
            doors = parseSmartServiceDoors(await this.request('Doors', params, signal));
        } catch (error) {
            const status = axios.isAxiosError(error) && error.response?.status;
            if (status === 401 || status === 403 || (error instanceof Error && /^SMARTLINK_.*(?:SESSION|KEY|NOT_LOGGED)/.test(error.message))) {
                await this.logout(key).catch(() => undefined);
            }
            throw error;
        }
        const readers: InventoryReaders = doors.map((door) => ({ ...door, state: 'unknown' }));
        const statusSignal = AbortSignal.any([signal, AbortSignal.timeout(20_000)]);
        for (let offset = 0; offset < readers.length && !statusSignal.aborted; offset += 4) {
            await Promise.all(readers.slice(offset, offset + 4).map(async (reader) => {
                try {
                    const xml = await this.request('ComponentFullStatus/' + encodeURIComponent(reader.id), params, statusSignal);
                    reader.state = parseSmartServiceDoorState(xml);
                } catch {
                    // Keep discovered doors visible even if their individual status is unavailable.
                }
            }));
        }
        return readers;
    }

    async logout(key = this.key) {
        if (!key || key !== this.key) return;
        this.key = undefined;
        await this.request('Logout', { sdKey: key });
    }
}
