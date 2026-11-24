import { DateTime } from 'luxon';
import axios from 'axios';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ZutServices } from '../services/ZutServices';
import { env } from '../config/env';
import type { Lesson } from './timeline';
import { CAMPUS_ZONE, parseCampusTime } from './scheduleTime';

export const normalizeRoom = (value: string) => value.normalize('NFKC').trim().toUpperCase();

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
    imie: z.string().nullish(),
    nazwisko: z.string().nullish(),
});

export function scheduleEventId(event: { id?: string | number; start?: string; room?: string; worker_title?: string }) {
    if (event.id !== undefined && event.id !== null) return event.id;
    const key = [event.start, event.room, event.worker_title].map((value) => value || '').join('|');
    const hash = createHash('md5').update(key).digest('hex');
    return parseInt(hash.substring(0, 8), 16) % 2147483647;
}

async function readLessons(scheduleId: string, at: Date, source?: string, daysAhead = 2): Promise<Lesson[]> {
    const campusDate = DateTime.fromJSDate(at, { zone: CAMPUS_ZONE });
    const response = await new ZutServices(source).getSchedule(
        scheduleId,
        'worker',
        campusDate.minus({ days: 1 }).toISODate()!,
        campusDate.plus({ days: daysAhead }).toISODate()!,
    );
    const matches = new Map<string, Lesson>();
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
        matches.set(key, {
            key, id, title: row.title, group: row.group_name?.trim() || null,
            start: start.toISOString(), end: end.toISOString(),
            room: row.room?.trim() || [row._building_id, row._room_number].filter(Boolean).join(' '),
            teacherScheduleId: scheduleId,
            teacherName: row.nazwisko && row.imie ? `${row.nazwisko.trim()} ${row.imie.trim()}` : undefined,
        });
    }
    return [...matches.values()].sort((a, b) => a.start.localeCompare(b.start) || a.key.localeCompare(b.key));
}

export async function findLessons(scheduleId: string, at: Date, source = env.ZUT_ATTENDANCE_SCHEDULE_URL): Promise<Lesson[]> {
    const lessons = await readLessons(scheduleId, at, source);
    const eligible = lessons.filter((lesson) => +at >= Date.parse(lesson.start) - 30 * 60_000 && +at < Date.parse(lesson.end));
    const current = eligible.filter((lesson) => Date.parse(lesson.start) <= +at);
    return current.length ? current : eligible;
}

export const foldName = (value: string) => value.toLowerCase().normalize('NFKD')
    .replace(/\p{M}/gu, '').replace(/ł/g, 'l').replace(/[^a-z0-9]/g, '');

export type LecturerName = { givenName: string | null; surname: string | null } | null;

const polishLetters: Record<string, string> = {
    a: 'aą', c: 'cć', e: 'eę', l: 'lł', n: 'nń', o: 'oó', s: 'sś', z: 'zźż',
};

function surnameSearchVariants(surname: string) {
    // Use a short fragment with the fewest possible spellings for the accent-sensitive search.
    const width = Math.min(3, surname.length);
    let fewest: string[] | undefined;
    for (let offset = 0; offset + width <= surname.length; offset++) {
        const letters = [...surname.slice(offset, offset + width)];
        const variants = letters.reduce<string[]>((terms, letter) =>
            terms.flatMap((term) => [...(polishLetters[letter] ?? letter)].map((spelling) => term + spelling)), ['']);
        if (!fewest || variants.length < fewest.length) fewest = variants;
    }
    return fewest ?? [];
}

function lecturerCardMatches(name: string, login: string, identity: LecturerName) {
    if (identity?.givenName && identity.surname) {
        const given = foldName(identity.givenName);
        const surname = foldName(identity.surname);
        return [surname + given, given + surname].includes(foldName(name));
    }
    const split = /^(.*)\s+(\S+)$/.exec(name);
    return Boolean(split && foldName(split[2])[0] + foldName(split[1]) === login);
}

async function searchLecturerSchedules(url: string, query: string, login: string, identity: LecturerName) {
    const response = await axios.get(url, {
        params: { kind: 'teacher', query }, timeout: 5_000, maxRedirects: 0,
    });
    if (!Array.isArray(response.data)) throw new Error('Invalid teacher search response');
    return response.data.flatMap((row) => {
        const name = typeof row?.item === 'string' ? row.item.trim() : '';
        if (!name || !lecturerCardMatches(name, login, identity)) return [];
        const id = typeof row.id === 'string' || typeof row.id === 'number' ? String(row.id) : name;
        return id ? [id] : [];
    });
}

export async function findLecturerLessons(
    login: string, identity: LecturerName, at: Date,
    source = env.ZUT_ATTENDANCE_SCHEDULE_URL ?? env.ZUT_SCHEDULE_STUDENT_URL,
) {
    const normalizedLogin = foldName(login);
    const surname = identity?.surname?.trim() || normalizedLogin.slice(1);
    if (!surname) return [];
    const url = new URL('schedule.php', source).href;
    const ids = new Set(await searchLecturerSchedules(url, surname, normalizedLogin, identity));
    if (!ids.size) {
        const queries = surnameSearchVariants(foldName(surname)).filter((query) => query && query !== surname);
        for (const result of await Promise.all(queries.map((query) => searchLecturerSchedules(url, query, normalizedLogin, identity)))) {
            for (const id of result) ids.add(id);
        }
    }
    const [id] = ids;
    return ids.size === 1 ? findLessons(id, at, source) : [];
}

export async function getTeacherSchedule(scheduleId: string, at: Date) {
    const lessons = await readLessons(scheduleId, at, undefined, 7);
    return {
        at: at.toISOString(),
        current: lessons.filter(({ start, end }) => Date.parse(start) <= +at && +at < Date.parse(end)),
        upcoming: lessons.filter(({ start }) => Date.parse(start) > +at).slice(0, 3),
    };
}
