import { DateTime } from 'luxon';

export const CAMPUS_ZONE = 'Europe/Warsaw';

export function parseCampusTime(value: string): Date | null {
    const normalized = value.trim().replace(' ', 'T');
    const time = DateTime.fromISO(normalized, { zone: CAMPUS_ZONE, setZone: true });
    if (!time.isValid) return null;
    const localInput = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?$/.exec(normalized);
    if (localInput && (time.getPossibleOffsets().length > 1 || time.toFormat("yyyy-MM-dd'T'HH:mm") !== localInput[1])) {
        return null;
    }
    return time.toJSDate();
}
