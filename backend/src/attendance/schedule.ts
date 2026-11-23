import { DateTime } from 'luxon';
import axios from 'axios';
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
    group_name: z.string().nullish(),
    login: z.string().nullish(),
    imie: z.string().nullish(),
    nazwisko: z.string().nullish(),
});

export function scheduleEventId(event: { id?: string | number; start?: string; room?: string; worker_title?: string }) {
    if (event.id !== undefined && event.id !== null) return event.id;
    const key = [event.start, event.room, event.worker_title].map((value) => value || '').join('|');
    const hash = createHash('md5').update(key).digest('hex');
    return parseInt(hash.substring(0, 8), 16) % 2147483647;
}

type ScheduledLesson = Lesson & {
    roomKey: string | null; room: string; login?: string; givenName?: string; surname?: string;
};

async function readLessons(scheduleId: string, at: Date, source?: string, daysAhead = 2, kind = 'worker'): Promise<ScheduledLesson[]> {
    const campusDate = DateTime.fromJSDate(at, { zone: CAMPUS_ZONE });
    const response = await new ZutServices(source).getSchedule(
        scheduleId,
        kind,
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
        const lessonKey = kind === 'worker' ? [key, roomKey] : [key, roomKey, row.login, row.imie, row.nazwisko];
        matches.set(JSON.stringify(lessonKey), {
            key, id, title: row.title, group: row.group_name?.trim() || null,
            start: start.toISOString(), end: end.toISOString(),
            roomKey, room: row.room?.trim() || [row._building_id, row._room_number].filter(Boolean).join(' '),
            teacherScheduleId: kind === 'worker' ? scheduleId : undefined,
            teacherName: row.nazwisko && row.imie ? `${row.nazwisko.trim()} ${row.imie.trim()}` : undefined,
            login: row.login?.trim().toLowerCase(), givenName: row.imie?.trim(), surname: row.nazwisko?.trim(),
        });
    }
    return [...matches.values()].sort((a, b) => a.start.localeCompare(b.start) || a.key.localeCompare(b.key));
}

export async function findLessons(scheduleId: string, roomKey: string, at: Date, source = env.ZUT_ATTENDANCE_SCHEDULE_URL): Promise<Lesson[]> {
    return eligibleLessons(await readLessons(scheduleId, at, source), roomKey, at).map(publicLesson);
}

const publicLesson = ({ roomKey: _roomKey, login: _login, givenName: _given, surname: _surname, ...lesson }: ScheduledLesson) => lesson;

function eligibleLessons(lessons: ScheduledLesson[], roomKey: string, at: Date) {
    const eligible = lessons
        .filter((lesson) => lesson.roomKey === roomKey
            && +at >= Date.parse(lesson.start) - 30 * 60_000 && +at < Date.parse(lesson.end));
    const current = eligible.filter((lesson) => Date.parse(lesson.start) <= +at);
    return current.length ? current : eligible;
}

export const foldName = (value: string) => value.toLowerCase().normalize('NFKD')
    .replace(/\p{M}/gu, '').replace(/ł/g, 'l').replace(/[^a-z0-9]/g, '');

export type LecturerName = { givenName: string | null; surname: string | null } | null;

export async function findLecturerLessons(
    login: string, identity: LecturerName, roomKey: string, roomNumber: string, at: Date,
    source = env.ZUT_ATTENDANCE_SCHEDULE_URL ?? env.ZUT_SCHEDULE_STUDENT_URL,
) {
    if (identity?.surname && identity.givenName) {
        const given = foldName(identity.givenName);
        const surname = foldName(identity.surname);
        const searchUrl = new URL('schedule.php', source);
        const response = await axios.get(searchUrl.href, {
            params: { kind: 'teacher', query: identity.surname },
            timeout: 5_000, maxRedirects: 0,
        });
        if (!Array.isArray(response.data)) throw new Error('Invalid teacher search response');
        const ids = new Set<string>();
        for (const row of response.data) {
            const name = typeof row?.item === 'string' ? row.item.trim() : '';
            if (![surname + given, given + surname].includes(foldName(name))) continue;
            const id = typeof row.id === 'string' || typeof row.id === 'number' ? String(row.id) : name;
            if (id) ids.add(id);
        }
        if (ids.size > 1) return [];
        if (ids.size === 1) return findLessons([...ids][0], roomKey, at, source);
    }

    // Plan ZUT search is accent-sensitive. A missing profile can still be matched against the room's timetable.
    const roomLessons = eligibleLessons(await readLessons(roomNumber, at, source, 2, 'room'), roomKey, at);
    const matches = roomLessons.filter((lesson) => {
        if (lesson.login) return lesson.login === login;
        if (!lesson.givenName || !lesson.surname) return false;
        if (identity?.givenName && identity.surname) {
            return foldName(lesson.givenName) === foldName(identity.givenName)
                && foldName(lesson.surname) === foldName(identity.surname);
        }
        return foldName(lesson.givenName)[0] + foldName(lesson.surname) === foldName(login);
    });
    const names = new Set(matches.map(({ givenName, surname, login: rowLogin }) =>
        givenName && surname ? foldName(surname + givenName) : rowLogin));
    if (names.size !== 1) return [];
    return matches.map((lesson) => ({
        ...publicLesson(lesson),
        teacherScheduleId: lesson.teacherName,
    }));
}

export async function getTeacherSchedule(scheduleId: string, at: Date) {
    const lessons = (await readLessons(scheduleId, at, undefined, 7)).map(publicLesson);
    return {
        at: at.toISOString(),
        current: lessons.filter(({ start, end }) => Date.parse(start) <= +at && +at < Date.parse(end)),
        upcoming: lessons.filter(({ start }) => Date.parse(start) > +at).slice(0, 3),
    };
}
