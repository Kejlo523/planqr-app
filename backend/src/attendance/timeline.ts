import { z } from 'zod';

export const lessonSchema = z.object({
    key: z.string(),
    id: z.string(),
    title: z.string(),
    group: z.string().nullable().optional(),
    room: z.string().optional(),
    teacherScheduleId: z.string().optional(),
    teacherName: z.string().optional(),
    start: z.string().datetime(),
    end: z.string().datetime(),
});

export type Lesson = z.infer<typeof lessonSchema>;

export interface Scan {
    id: string;
    readerId: string;
    roomKey: string;
    roomLabel: string;
    alias: string;
    login: string;
    name: string;
    album: string | null;
    scheduleId: string | null;
    isLecturer?: boolean | null;
    readerDirection?: 'ENTRY' | 'EXIT' | null;
    exitReaderId?: string | null;
    occurredAt: Date;
    candidates: Lesson[];
    selectedKey: string | null;
    resolution: string;
}

export interface Member {
    login: string;
    name: string;
    album: string | null;
    firstAt: Date;
    lastAt: Date;
    count: number;
}

export interface Session {
    key: string;
    lesson: Lesson;
    opener: Scan;
    closesAt: Date | null;
    members: Map<string, Member>;
}

const OPEN_WINDOW = 30 * 60_000;
const READER_DEBOUNCE = 3_000;
const SINGLE_READER_CLOSE_DELAY = 60_000;

export function buildTimeline(scans: Scan[], manualCloses: ReadonlyMap<string, Date>) {
    const sessions = new Map<string, Session>();
    const outcomes = new Map<string, string>();
    const previousTap = new Map<string, number>();
    let active: Session | undefined;

    for (const scan of scans) {
        const at = scan.occurredAt.getTime();
        if (active?.closesAt && at >= active.closesAt.getTime()) {
            active = undefined;
        }
        const singleReaderClose = active?.opener.exitReaderId === scan.readerId &&
            active.opener.readerId === scan.readerId && active.opener.login === scan.login &&
            scan.readerDirection === 'ENTRY';
        const tapKey = scan.readerDirection ? JSON.stringify([scan.readerId, scan.login]) : scan.alias;
        const previous = previousTap.get(tapKey);
        if (!singleReaderClose && previous !== undefined && at - previous < READER_DEBOUNCE) {
            outcomes.set(scan.id, 'repeat_tap');
            continue;
        }
        const isLecturer = scan.isLecturer ?? Boolean(scan.scheduleId);
        if (active) {
            previousTap.set(tapKey, at);
            const owner = active.opener.login === scan.login;
            const exitReaderId = active.opener.exitReaderId;
            if (singleReaderClose && at - active.opener.occurredAt.getTime() < SINGLE_READER_CLOSE_DELAY) {
                outcomes.set(scan.id, 'close_too_soon');
                continue;
            }
            if (owner && (singleReaderClose || !exitReaderId || (scan.readerDirection === 'EXIT' && scan.readerId === exitReaderId))) {
                active.closesAt = scan.occurredAt;
                active = undefined;
                outcomes.set(scan.id, 'closed');
                continue;
            }
            if (exitReaderId && (scan.readerDirection !== 'ENTRY' || scan.readerId !== active.opener.readerId)) {
                outcomes.set(scan.id, scan.readerDirection === 'EXIT' ? 'exit_ignored' : 'wrong_entry_reader');
                continue;
            }
            if (exitReaderId && (owner || isLecturer)) {
                outcomes.set(scan.id, owner ? 'repeat_tap' : 'room_in_use');
                continue;
            }
            const member = active.members.get(scan.login);
            if (member) {
                if (exitReaderId) {
                    outcomes.set(scan.id, 'repeat_tap');
                    continue;
                }
                member.lastAt = scan.occurredAt;
                member.count++;
            } else {
                active.members.set(scan.login, {
                    login: scan.login, name: scan.name, album: scan.album,
                    firstAt: scan.occurredAt, lastAt: scan.occurredAt, count: 1,
                });
            }
            outcomes.set(scan.id, 'recorded');
            continue;
        }
        if (scan.readerDirection === 'EXIT') {
            outcomes.set(scan.id, 'exit_ignored');
            continue;
        }

        const eligible = scan.candidates.filter((lesson) =>
            at >= Date.parse(lesson.start) - OPEN_WINDOW && at < Date.parse(lesson.end),
        );
        const lesson = scan.selectedKey
            ? eligible.find(({ key }) => key === scan.selectedKey)
            : eligible.length === 1 ? eligible[0] : undefined;
        if (!lesson) {
            const noLesson = scan.resolution === 'pending' ? 'pending' : 'no_match';
            outcomes.set(scan.id, eligible.length > 1 ? 'choose_lesson'
                : isLecturer ? noLesson : 'no_session');
            continue;
        }
        const key = JSON.stringify([scan.roomKey, scan.login, lesson.key]);
        if (sessions.has(key)) {
            outcomes.set(scan.id, 'already_closed');
            continue;
        }
        const plannedEnd = new Date(lesson.end);
        const manualEnd = manualCloses.get(key);
        const closesAt = scan.exitReaderId ? null : manualEnd && manualEnd < plannedEnd ? manualEnd : plannedEnd;
        active = { key, lesson, opener: scan, closesAt, members: new Map() };
        previousTap.set(tapKey, at);
        sessions.set(key, active);
        outcomes.set(scan.id, 'opened');
    }
    return { sessions, outcomes };
}
