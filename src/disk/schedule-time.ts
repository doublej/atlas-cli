/** Weekly schedule times: parse `--at "Sun 10:00"`, print them back, compute the next run. */
import type { Schedule } from './settings';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** "Sun 10:00", "sunday 9:30" or "0 10:00" → weekday/hour/minute. */
export function parseAt(at: string): Pick<Schedule, 'weekday' | 'hour' | 'minute'> {
	const m = /^\s*(\w+)\s+(\d{1,2}):(\d{2})\s*$/.exec(at);
	const day = m?.[1].toLowerCase() ?? '';
	const weekday = /^[0-6]$/.test(day) ? Number(day) : DAYS.findIndex((d) => day.length >= 3 && d.toLowerCase().startsWith(day.slice(0, 3)));
	const hour = Number(m?.[2]);
	const minute = Number(m?.[3]);
	if (!m || weekday < 0 || hour > 23 || minute > 59) throw new Error(`--at needs "<Sun..Sat> HH:MM", got '${at}'`);
	return { weekday, hour, minute };
}

export const formatAt = (s: Schedule): string => `${DAYS[s.weekday]} ${String(s.hour).padStart(2, '0')}:${String(s.minute).padStart(2, '0')}`;

/** The next local time strictly after `now` that matches the schedule. */
export function nextRun(s: Schedule, now = new Date()): Date {
	const d = new Date(now);
	d.setHours(s.hour, s.minute, 0, 0);
	d.setDate(d.getDate() + ((s.weekday - d.getDay() + 7) % 7));
	if (d <= now) d.setDate(d.getDate() + 7);
	return d;
}
