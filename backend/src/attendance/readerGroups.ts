import { Prisma, ReaderDirection } from '@prisma/client';
import { z } from 'zod';
import { groupInventoryByDevice } from './inventory';
import { ReaderConfigurationError, readerIdSchema, requireIdleReaders } from './readers';
import { attendanceDb, lockReaderConfiguration } from './store';

const roles = z.enum(['ENTRY', 'EXIT', 'BOTH']);
type Role = z.infer<typeof roles>;
const groupIdSchema = z.coerce.number().int().positive();
export const readerGroupInput = z.object({
    id: groupIdSchema.optional(),
    name: z.string().trim().min(1).max(128),
    devices: z.array(z.object({
        id: z.string().trim().min(1).max(64),
        readers: z.array(z.object({ id: readerIdSchema, role: roles })).min(1).max(64),
    })).min(1).max(32),
});

const groupReaders = { readers: { orderBy: { id: 'asc' } } } satisfies Prisma.AttendanceReaderGroupInclude;
type Group = Prisma.AttendanceReaderGroupGetPayload<{ include: typeof groupReaders }>;

function viewGroup({ id, name, readers }: Group) {
    const devices = new Map<string, { id: string; readers: { id: string; label: string; role: Role }[] }>();
    for (const reader of readers) {
        if (!reader.deviceId) continue;
        const device = devices.get(reader.deviceId) ?? { id: reader.deviceId, readers: [] };
        device.readers.push({
            id: reader.id, label: reader.label, role: reader.singleReader ? 'BOTH' : reader.direction ?? 'ENTRY',
        });
        devices.set(reader.deviceId, device);
    }
    return { id, name, devices: [...devices.values()] };
}

async function readInventory(tx: Prisma.TransactionClient) {
    const snapshot = await tx.kantechInventory.findUnique({ where: { id: 1 } });
    return { devices: groupInventoryByDevice(snapshot?.readers), checkedAt: snapshot?.checkedAt ?? null };
}

export async function listReaderGroups() {
    const [groups, inventory] = await Promise.all([
        attendanceDb.attendanceReaderGroup.findMany({ include: groupReaders, orderBy: { name: 'asc' } }),
        readInventory(attendanceDb),
    ]);
    return { groups: groups.map(viewGroup), ...inventory };
}

export async function saveReaderGroup(input: z.infer<typeof readerGroupInput>) {
    return attendanceDb.$transaction(async (tx) => {
        await lockReaderConfiguration(tx);
        const current = input.id === undefined ? null : await tx.attendanceReaderGroup.findUnique({
            where: { id: input.id }, include: groupReaders,
        });
        if (input.id !== undefined && !current) throw new ReaderConfigurationError('Grupa już nie istnieje.');
        const { devices } = await readInventory(tx);
        const selected = new Map<string, { deviceId: string; label: string; role: Role }>();
        const selectedDevices = new Set<string>();
        for (const device of input.devices) {
            if (selectedDevices.has(device.id)) throw new ReaderConfigurationError('Urządzenie występuje w grupie więcej niż raz.');
            selectedDevices.add(device.id);
            const saved = current?.readers.filter(({ deviceId }) => deviceId === device.id) ?? [];
            const available = new Map(saved.map(({ id, label }) => [id, label]));
            for (const { id, label } of devices.find(({ id }) => id === device.id)?.readers ?? []) {
                available.set(id, label ?? id);
            }
            if (device.readers.length !== available.size) {
                throw new ReaderConfigurationError('Spis czytników urządzenia się zmienił. Odśwież konfigurację.');
            }
            for (const { id, role } of device.readers) {
                const label = available.get(id);
                if (!label || selected.has(id)) throw new ReaderConfigurationError('Czytnik nie należy do wybranego urządzenia.');
                selected.set(id, { deviceId: device.id, role, label });
            }
        }
        const readers = [...selected.values()];
        if (!readers.some(({ role }) => role !== 'EXIT') || !readers.some(({ role }) => role !== 'ENTRY')) {
            throw new ReaderConfigurationError('Wybierz wejście i wyjście dla grupy. Jeden czytnik może obsługiwać oba kierunki.');
        }
        const ids = [...selected.keys()];
        const conflict = await tx.attendanceReader.findFirst({
            where: {
                groupId: current ? { not: current.id } : { not: null },
                OR: [{ id: { in: ids } }, { deviceId: { in: [...selectedDevices] } }],
            },
        });
        if (conflict) throw new ReaderConfigurationError('Urządzenie lub jego czytnik jest już w innej grupie.');
        const existing = await tx.attendanceReader.findMany({
            where: { id: { in: ids } }, include: { entryReader: { select: { id: true } } },
        });
        if (existing.some(({ exitReaderId, entryReader }) =>
            [exitReaderId, entryReader?.id].some((partner) => partner && !selected.has(partner)))) {
            throw new ReaderConfigurationError('Wybierz również urządzenie powiązane z dotychczasową parą czytników.');
        }
        await requireIdleReaders(tx, [...ids, ...current?.readers.map(({ id }) => id) ?? []], current?.id);
        const group = current
            ? await tx.attendanceReaderGroup.update({ where: { id: current.id }, data: { name: input.name } })
            : await tx.attendanceReaderGroup.create({ data: { name: input.name } });
        await tx.attendanceReader.updateMany({
            where: { groupId: group.id, id: { notIn: ids } },
            data: { groupId: null, deviceId: null, direction: null, singleReader: false },
        });
        for (const [id, { label, deviceId, role }] of selected) {
            const data = {
                groupId: group.id, deviceId, exitReaderId: null, singleReader: role === 'BOTH',
                direction: role === 'EXIT' ? ReaderDirection.EXIT : ReaderDirection.ENTRY,
            };
            await tx.attendanceReader.upsert({
                where: { id }, create: { id, ...data, label, buildingId: '', roomNumber: '' }, update: data,
            });
        }
        return viewGroup(await tx.attendanceReaderGroup.findUniqueOrThrow({ where: { id: group.id }, include: groupReaders }));
    });
}

export async function deleteReaderGroup(value: string) {
    const id = groupIdSchema.parse(value);
    await attendanceDb.$transaction(async (tx) => {
        await lockReaderConfiguration(tx);
        const group = await tx.attendanceReaderGroup.findUnique({ where: { id }, include: groupReaders });
        if (!group) return;
        await requireIdleReaders(tx, group.readers.map((reader) => reader.id), id);
        await tx.attendanceReader.updateMany({
            where: { groupId: id }, data: { groupId: null, deviceId: null, direction: null, singleReader: false },
        });
        await tx.attendanceReaderGroup.delete({ where: { id } });
    });
}
