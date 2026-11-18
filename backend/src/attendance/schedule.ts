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
    _building_id: z.string().nullish(),
    _room_number: z.string().nullish(),
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

type ScheduledLesson = Lesson & { roomKey: string | null; room: string };

async function readLessons(scheduleId: string, at: Date, source?: string, daysAhead = 2): Promise<ScheduledLesson[]> {
    const campusDate = DateTime.fromJSDate(at, { zone: CAMPUS_ZONE });
    const response = await new ZutServices(source).getSchedule(
        scheduleId,
        'worker',
        campusDate.minus({ days: 1 }).toISODate()!,
        campusDate.plus({ days: daysAhead }).toISODate()!,
    );
    const matches = new Map<string, ScheduledLesson>();
    for (const entry of response) {
        const parsed = scheduleEntry.safeParse(entry);
        if (!parsed.success) continue;
        const row = parsed.data;
        if (/rezerw|reservation|cancel|odwoł/i.test([row._type, row.lesson_status].join(' '))) {
            continue;
        }
        const start = parseCampusTime(row.start);
        const end = parseCampusTime(row.end);
        if (!start || !end || start >= end) continue;
        const id = String(scheduleEventId(row));
        const key = JSON.stringify([id, start.toISOString()]);
        const roomKey = row._building_id && row._room_number
            ? getRoomKey(row._building_id, row._room_number) : null;
        matches.set(JSON.stringify([key, roomKey]), {
            key, id, title: row.title, start: start.toISOString(), end: end.toISOString(),
            roomKey, room: row.room?.trim() || [row._building_id, row._room_number].filter(Boolean).join(' '),
        });
    }
    return [...matches.values()].sort((a, b) => a.start.localeCompare(b.start) || a.key.localeCompare(b.key));
}

export async function findLessons(scheduleId: string, roomKey: string, at: Date, source = env.ZUT_ATTENDANCE_SCHEDULE_URL): Promise<Lesson[]> {
    return (await readLessons(scheduleId, at, source))
        .filter((lesson) => lesson.roomKey === roomKey
            && +at >= Date.parse(lesson.start) - 30 * 60_000 && +at < Date.parse(lesson.end))
        .map(({ roomKey: _roomKey, room: _room, ...lesson }) => lesson);
}

export async function getTeacherSchedule(scheduleId: string, at: Date) {
    const lessons = (await readLessons(scheduleId, at, undefined, 7)).map(({ roomKey: _roomKey, ...lesson }) => lesson);
    return {
        at: at.toISOString(),
        current: lessons.filter(({ start, end }) => Date.parse(start) <= +at && +at < Date.parse(end)),
        upcoming: lessons.filter(({ start }) => Date.parse(start) > +at).slice(0, 3),
    };
}
