import { AuditCategory, Prisma, PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const settingId = 1;
const day = 24 * 60 * 60 * 1000;
const cleanupInterval = 60 * 60 * 1000;
let nextWriteWarning = 0;

type AuditEntry = {
    category: AuditCategory;
    action: string;
    actor: string;
    target?: unknown;
};

const shortText = (value: string) => value.trim().replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 160);
const cutoff = (days: number) => new Date(Date.now() - days * day);

export function writeAuditEvent({ category, action, actor, target }: AuditEntry) {
    const selected = typeof target === 'number' ? String(target) : target;
    void prisma.auditEvent.create({
        data: {
            category, action, actor: shortText(actor),
            target: typeof selected === 'string' ? shortText(selected) || null : null,
        },
    }).catch(() => {
        if (Date.now() < nextWriteWarning) return;
        nextWriteWarning = Date.now() + 60_000;
        console.warn('[Audit] Could not save an audit entry.');
    });
}

export async function listAuditEvents(options: {
    before?: number; category?: AuditCategory; query?: string; limit: number;
}) {
    const { retentionDays } = await prisma.auditSettings.findUniqueOrThrow({ where: { id: settingId } });
    const search = options.query?.replace(/[\\%_]/g, '\\$&');
    const match = search ? { contains: search, mode: 'insensitive' as const } : undefined;
    const entries = await prisma.auditEvent.findMany({
        where: {
            category: options.category,
            id: options.before === undefined ? undefined : { lt: options.before },
            occurredAt: { gte: cutoff(retentionDays) },
            OR: match ? [{ actor: match }, { action: match }, { target: match }] : undefined,
        },
        orderBy: { id: 'desc' },
        take: options.limit + 1,
    });
    const nextBefore = entries.length > options.limit ? entries[options.limit - 1].id : null;
    return { entries: entries.slice(0, options.limit), nextBefore, retentionDays };
}

async function lockRetention(database: Prisma.TransactionClient) {
    const [settings] = await database.$queryRaw<Array<{ retentionDays: number }>>`
        SELECT "retentionDays" FROM "AuditSettings" WHERE id = ${settingId} FOR UPDATE
    `;
    if (!settings) throw new Error('Missing audit retention settings');
    return settings.retentionDays;
}

function removeExpired(database: Prisma.TransactionClient, days: number) {
    return database.auditEvent.deleteMany({ where: { occurredAt: { lt: cutoff(days) } } });
}

export function updateAuditRetention(days: number, actor: string) {
    return prisma.$transaction(async (database) => {
        const previous = await lockRetention(database);
        if (previous !== days) {
            await database.auditSettings.update({ where: { id: settingId }, data: { retentionDays: days } });
            await database.auditEvent.create({ data: {
                category: 'ADMIN', action: 'Zmieniono okres przechowywania logów',
                actor: shortText(actor), target: `${previous} → ${days} dni`,
            } });
        }
        const { count } = await removeExpired(database, days);
        return { retentionDays: days, removed: count };
    });
}

export function startAuditCleanup() {
    const prune = () => void prisma.$transaction(async (database) => {
        await removeExpired(database, await lockRetention(database));
    }).catch(() => console.warn('[Audit] Could not remove expired entries.'));
    prune();
    setInterval(prune, cleanupInterval).unref();
}
