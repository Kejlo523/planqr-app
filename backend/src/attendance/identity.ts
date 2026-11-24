import type { AttendanceCard, LdapUser } from '@prisma/client';
import { normalizeCardLogin } from './cardAlias';

const studentLogin = /^s([0-9]+)$/;
const lecturerLogin = /^[a-z][a-z-]{2,}$/;

export function attendanceIdentity(alias: string, card?: AttendanceCard, profile?: LdapUser | null) {
    if (card) {
        const isLecturer = Boolean(card.scheduleId);
        const album = card.album ?? (isLecturer ? null : studentLogin.exec(normalizeCardLogin(card.login))?.[1] ?? null);
        return { ...card, album, isLecturer };
    }
    const login = normalizeCardLogin(alias);
    if (profile?.isActive === 0) return null;
    const album = studentLogin.exec(login)?.[1] ?? null;
    const isLecturer = !album && profile?.title?.toLowerCase() !== 'student' &&
        (lecturerLogin.test(login) || Boolean(profile?.givenName && profile.surname));
    if (!isLecturer && !album) return null;
    return { alias: login, login, name: profile?.displayName || login, album, scheduleId: null, isLecturer };
}
