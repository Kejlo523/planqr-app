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

export async function saveInventory(database: PrismaClient, readers: InventoryReaders) {
    const data = { readers, checkedAt: new Date() };
    await database.kantechInventory.upsert({
        where: { id: 1 }, create: { id: 1, ...data }, update: data,
    });
}
