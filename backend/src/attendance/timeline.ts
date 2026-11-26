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
    rulesVersion?: number;
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

export const ATTENDANCE_RULES_VERSION = 2;
export const attendanceDeadline = (end: string) => Date.parse(end) - 30 * 60_000;
export const readerGroupScope = (id: number) => `group:${id}`;
export const isReaderGroupScope = (scope: string) => scope.startsWith('group:');

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
        const owner = active?.opener.login === scan.login;
        const currentSession = active?.opener.rulesVersion === ATTENDANCE_RULES_VERSION;
        const grouped = isReaderGroupScope(scan.roomKey);
        const singleReaderClose = owner && scan.readerDirection === 'ENTRY' &&
            (grouped ? scan.exitReaderId === scan.readerId
                : active?.opener.exitReaderId === scan.readerId && active.opener.readerId === scan.readerId);
        const tapKey = scan.readerDirection ? JSON.stringify([scan.readerId, scan.login]) : scan.alias;
        const previous = previousTap.get(tapKey);
        if (!singleReaderClose && previous !== undefined && at - previous < READER_DEBOUNCE) {
            outcomes.set(scan.id, 'repeat_tap');
            continue;
        }
        const isLecturer = scan.isLecturer ?? Boolean(scan.scheduleId);
        if (active) {
            previousTap.set(tapKey, at);
            const exitReaderId = active.opener.exitReaderId;
            if (singleReaderClose && at - active.opener.occurredAt.getTime() < SINGLE_READER_CLOSE_DELAY) {
                outcomes.set(scan.id, 'close_too_soon');
                continue;
            }
            const atExit = scan.readerDirection === 'EXIT' && (grouped || scan.readerId === exitReaderId);
            if (owner && (singleReaderClose || atExit || (!currentSession && !exitReaderId))) {
                active.closesAt = scan.occurredAt;
                active = undefined;
                outcomes.set(scan.id, 'closed');
                continue;
            }
            const atEntry = scan.readerDirection === 'ENTRY' && (grouped || scan.readerId === active.opener.readerId);
            if ((grouped || exitReaderId) && !atEntry && !(currentSession && atExit)) {
                outcomes.set(scan.id, scan.readerDirection === 'EXIT' ? 'exit_ignored' : 'wrong_entry_reader');
                continue;
            }
            if (currentSession ? owner : exitReaderId && (owner || isLecturer)) {
                outcomes.set(scan.id, owner ? 'repeat_tap' : 'room_in_use');
                continue;
            }
            const member = active.members.get(scan.login);
            if (member) {
                if (currentSession || exitReaderId) {
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

        const currentRules = scan.rulesVersion === ATTENDANCE_RULES_VERSION;
        const endOfAttendance = currentRules ? attendanceDeadline : Date.parse;
        const eligible = scan.candidates.filter((lesson) =>
            at >= Date.parse(lesson.start) - OPEN_WINDOW && at < endOfAttendance(lesson.end),
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
        const plannedEnd = new Date(endOfAttendance(lesson.end));
        const manualEnd = manualCloses.get(key);
        const closesAt = !currentRules && scan.exitReaderId ? null
            : manualEnd && manualEnd < plannedEnd ? manualEnd : plannedEnd;
        active = { key, lesson, opener: scan, closesAt, members: new Map() };
        previousTap.set(tapKey, at);
        sessions.set(key, active);
        outcomes.set(scan.id, 'opened');
    }
    return { sessions, outcomes };
}
