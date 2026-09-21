/**
 * `atlas disk schedule [status] | enable <scan|trim> [--at "Sun 10:00"] | disable <scan|trim>
 * | set <scan|trim> --at "Sun 10:00"` — the weekly scan and trim launchd jobs.
 */
import { existsSync } from 'node:fs';
import { parseFlags } from './flags';
import { EXIT, type Report } from './report';
import { ago } from './fsutil';
import { loadSettings, saveSettings, type Settings } from './settings';
import { install, isLoaded, JOBS, lastRun, linkTarget, plistCurrent, plistPath, uninstall, WRAPPER, type Job, type LastRun } from './schedule-launchd';
import { formatAt, nextRun, parseAt } from './schedule-time';

export interface ScheduleStatus {
	job: Job;
	label: string;
	enabled: boolean;
	at: string;
	/** LaunchAgents symlink present and the job loaded. */
	installed: boolean;
	/** Link points at our plist, the wrapper exists and the plist matches the settings. */
	rightPlace: boolean;
	problem: string | null;
	nextRun: string | null;
	lastRun: (LastRun & { result: string }) | null;
}

const exitName = (code: number) => Object.entries(EXIT).find(([, n]) => n === code)?.[0] ?? `exit ${code}`;

export function scheduleStatus(job: Job, s: Settings): ScheduleStatus {
	const sched = s.schedules[job];
	const target = linkTarget(job);
	const loaded = isLoaded(job);
	const installed = target !== null && loaded;
	const wrong =
		target === null ? null : target !== plistPath(job) ? `link points at ${target}` : !existsSync(WRAPPER) ? `wrapper missing: ${WRAPPER}` : !plistCurrent(job, sched) ? 'plist is out of date with the settings' : null;
	const problem = sched.enabled && !installed ? (target === null ? 'enabled but not installed' : 'enabled but not loaded') : !sched.enabled && (target || loaded) ? 'disabled but still installed' : wrong;
	const last = lastRun(job);
	return {
		job,
		label: JOBS[job].label,
		enabled: sched.enabled,
		at: formatAt(sched),
		installed,
		rightPlace: target !== null && wrong === null,
		problem,
		nextRun: sched.enabled ? nextRun(sched).toISOString() : null,
		lastRun: last && { ...last, result: exitName(last.exit) }
	};
}

function renderStatus(rows: ScheduleStatus[]): string {
	return rows
		.map((r) => {
			const state = r.enabled ? `enabled  ${r.at}` : 'disabled';
			const next = r.nextRun ? `next ${new Date(r.nextRun).toLocaleString()}` : 'no next run';
			const last = r.lastRun ? `last ${ago(r.lastRun.finishedAt)} → ${r.lastRun.result}  (${r.lastRun.log})` : 'never run';
			return `${r.job.padEnd(5)} ${state.padEnd(20)} ${r.installed ? 'installed' : 'not installed'} · ${next} · ${last}${r.problem ? `\n      ⚠ ${r.problem}` : ''}`;
		})
		.join('\n');
}

function jobArg(j: string | undefined): Job {
	if (j !== 'scan' && j !== 'trim') throw new Error(`which schedule? scan or trim, got '${j ?? ''}'`);
	return j;
}

export async function run(args: string[]): Promise<Report> {
	const f = parseFlags(args);
	const [verb = 'status', j] = f.positional;
	const s = loadSettings();
	if (verb === 'status') {
		const rows = (Object.keys(JOBS) as Job[]).map((job) => scheduleStatus(job, s));
		return { command: 'schedule', exit: 'ok', data: rows, text: renderStatus(rows) };
	}
	if (!['enable', 'disable', 'set'].includes(verb)) throw new Error(`unknown verb '${verb}' (status | enable | disable | set)`);
	const job = jobArg(j);
	const at = f.get('at');
	if (verb === 'set' && !at) throw new Error('usage: atlas disk schedule set <scan|trim> --at "Sun 10:00"');
	// a fresh object: loadSettings() shares the default schedule objects
	s.schedules = { ...s.schedules, [job]: { ...s.schedules[job], ...(at ? parseAt(at) : {}), ...(verb === 'set' ? {} : { enabled: verb === 'enable' }) } };
	saveSettings(s);
	const error = s.schedules[job].enabled ? install(job, s.schedules[job]) : (uninstall(job), null);
	const row = scheduleStatus(job, s);
	const text = error ? `✗ ${job}: ${error}` : renderStatus([row]);
	return { command: 'schedule', exit: error ? 'error' : 'ok', data: row, text };
}
