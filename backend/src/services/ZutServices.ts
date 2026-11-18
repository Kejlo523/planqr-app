import axios from 'axios';
import { DateTime } from 'luxon';
import { env } from '../config/env';
import { CAMPUS_ZONE } from '../attendance/scheduleTime';

const readDay = (value: string) =>
    DateTime.fromISO(value.split('T')[0], { zone: CAMPUS_ZONE }).startOf('day');

export class ZutServices {
    constructor(private readonly scheduleUrl = env.ZUT_SCHEDULE_STUDENT_URL) {}

    async getSchedule(id: string, kind: string, startParam?: string, endParam?: string): Promise<unknown[]> {
        const currentWeek = DateTime.now().setZone(CAMPUS_ZONE).startOf('week');
        const start = startParam && endParam ? readDay(startParam) : currentWeek;
        const end = startParam && endParam ? readDay(endParam) : currentWeek.plus({ days: 6 });
        if (!start.isValid || !end.isValid) throw new Error('Invalid schedule date range');

        const key = kind === 'student' ? 'number' : ['worker', 'teacher'].includes(kind) ? 'teacher' : 'room';
        const response = await axios.get(this.scheduleUrl, {
            params: { [key]: id, start: start.toISO({ suppressMilliseconds: true }), end: end.toISO({ suppressMilliseconds: true }) },
            headers: { 'User-Agent': 'Mozilla/5.0' },
            timeout: 5_000,
        });
        if (!Array.isArray(response.data)) throw new Error('Invalid schedule response');
        return response.data;
    }
}
