import { DateTime } from 'luxon';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ZutServices } from '../services/ZutServices';
import { env } from '../config/env';
import type { Lesson } from './timeline';
import { CAMPUS_ZONE, parseCampusTime } from './scheduleTime';

export const normalizeRoom = (value: string) => value.normalize('NFKC').trim().toUpperCase();
export const getRoomKey = (buildingId: string, roomNumber: string) =>
    JSON.stringify([normalizeRoom(buildingId), normalizeRoom(roomNumber)]);

const scheduleEntry = z.object({
    id: z.union([z.string(), z.number()]).optional(),
    title: z.string(),
    start: z.string(),
    end: z.string(),
    _building_id: z.string(),
    _room_number: z.string(),
    _type: z.string().optional(),
    lesson_status: z.string().optional(),
    room: z.string().optional(),
    worker_title: z.string().optional(),
});

export function scheduleEventId(event: { id?: string | number; start?: string; room?: string; worker_title?: string }) {
    if (event.id !== undefined && event.id !== null) return event.id;
    const key = [event.start, event.room, event.worker_title].map((value) => value || '').join('|');
    const hash = createHash('md5').update(key).digest('hex');
    return parseInt(hash.substring(0, 8), 16) % 2147483647;
}

export async function findLessons(scheduleId: string, roomKey: string, at: Date): Promise<Lesson[]> {
    const campusDate = DateTime.fromJSDate(at, { zone: CAMPUS_ZONE });
    const response: unknown = await new ZutServices(env.ZUT_ATTENDANCE_SCHEDULE_URL).getSchedule(
        scheduleId,
        'worker',
        campusDate.minus({ days: 1 }).toISODate()!,
        campusDate.plus({ days: 2 }).toISODate()!,
    );
    if (!Array.isArray(response)) throw new Error('Unexpected schedule response');

    const matches = new Map<string, Lesson>();
    for (const entry of response) {
        const parsed = scheduleEntry.safeParse(entry);
        if (!parsed.success) continue;
        const row = parsed.data;
        if (getRoomKey(row._building_id, row._room_number) !== roomKey
            || /rezerw|reservation|cancel|odwoł/i.test([row._type, row.lesson_status].join(' '))) {
            continue;
        }
        const start = parseCampusTime(row.start);
        const end = parseCampusTime(row.end);
        if (!start || !end || start >= end || at.getTime() < start.getTime() - 30 * 60_000 || at >= end) continue;
        const id = String(scheduleEventId(row));
        const key = JSON.stringify([id, start.toISOString()]);
        matches.set(key, { key, id, title: row.title, start: start.toISOString(), end: end.toISOString() });
    }
    return [...matches.values()].sort((a, b) => a.start.localeCompare(b.start) || a.key.localeCompare(b.key));
}
