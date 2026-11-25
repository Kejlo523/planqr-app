import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';

export const inventoryDoor = z.object({
    id: z.string().regex(/^\w[\w.:-]{0,63}$/),
    label: z.string().trim().max(256).nullable(),
});

export const inventoryReaders = z.array(inventoryDoor.extend({
    state: z.enum(['online', 'offline', 'disabled', 'unknown']),
}));

export type InventoryDoor = z.infer<typeof inventoryDoor>;
export type InventoryReaders = z.infer<typeof inventoryReaders>;

export function groupInventoryByDevice(input: unknown) {
    const snapshot = inventoryReaders.safeParse(input);
    const devices = new Map<string, { id: string; name: string; readers: InventoryReaders }>();
    if (!snapshot.success) return [];
    for (const reader of snapshot.data) {
        const match = reader.label?.match(/^\s*(?:\((\d+(?:\.\d+)+)\)\s*)?RCP[\s_-]*(\d+)(?=$|[\s_.:/-])/i);
        if (!match || !/^\d+$/.test(reader.id)) continue;
        const name = 'RCP-' + match[2].replace(/^0+(?=\d)/, '').padStart(2, '0');
        const address = match[1]?.split('.').slice(0, -1).join('.');
        const id = address ? `${name}@${address}` : name;
        const device = devices.get(id) ?? { id, name, readers: [] };
        if (!device.readers.some(({ id }) => id === reader.id)) device.readers.push(reader);
        devices.set(id, device);
    }
    return [...devices.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export async function saveInventory(database: PrismaClient, readers: InventoryReaders) {
    const data = { readers, checkedAt: new Date() };
    await database.kantechInventory.upsert({
        where: { id: 1 }, create: { id: 1, ...data }, update: data,
    });
}
