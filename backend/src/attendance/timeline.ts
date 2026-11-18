import { z } from 'zod';

export const lessonSchema = z.object({
    key: z.string(),
    id: z.string(),
    title: z.string(),
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
    closesAt: Date;
    members: Map<string, Member>;
}

const OPEN_WINDOW = 30 * 60_000;
const READER_DEBOUNCE = 3_000;

export function buildTimeline(scans: Scan[], manualCloses: ReadonlyMap<string, Date>) {
    const sessions = new Map<string, Session>();
    const outcomes = new Map<string, string>();
    const previousTap = new Map<string, number>();
    let active: Session | undefined;

    for (const scan of scans) {
        const at = scan.occurredAt.getTime();
        const previous = previousTap.get(scan.alias);
        if (previous !== undefined && at - previous < READER_DEBOUNCE) {
            outcomes.set(scan.id, 'repeat_tap');
            continue;
        }
        if (active && at >= active.closesAt.getTime()) {
            active = undefined;
        }
        if (active) {
            previousTap.set(scan.alias, at);
            if (active.opener.login === scan.login) {
                active.closesAt = scan.occurredAt;
                active = undefined;
                outcomes.set(scan.id, 'closed');
                continue;
            }
            const member = active.members.get(scan.login);
            if (member) {
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

        const eligible = scan.candidates.filter((lesson) =>
            at >= Date.parse(lesson.start) - OPEN_WINDOW && at < Date.parse(lesson.end),
        );
        const lesson = scan.selectedKey
            ? eligible.find(({ key }) => key === scan.selectedKey)
            : eligible.length === 1 ? eligible[0] : undefined;
        if (!lesson) {
            const noLesson = scan.resolution === 'pending' ? 'pending' : 'no_match';
            outcomes.set(scan.id, eligible.length > 1 ? 'choose_lesson'
                : scan.scheduleId ? noLesson : 'no_session');
            continue;
        }
        const key = JSON.stringify([scan.roomKey, scan.login, lesson.key]);
        if (sessions.has(key)) {
            outcomes.set(scan.id, 'already_closed');
            continue;
        }
        const plannedEnd = new Date(lesson.end);
        const manualEnd = manualCloses.get(key);
        const closesAt = manualEnd && manualEnd < plannedEnd ? manualEnd : plannedEnd;
        active = { key, lesson, opener: scan, closesAt, members: new Map() };
        previousTap.set(scan.alias, at);
        sessions.set(key, active);
        outcomes.set(scan.id, 'opened');
    }
    return { sessions, outcomes };
}
