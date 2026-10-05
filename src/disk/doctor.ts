/**
 * `atlas disk doctor [--json]` — what is wrong with the setup, each with a fix. Read-only.
 * Exit: ok when there are no errors or warnings, partial when there are (info never counts).
 */
import { accessSync, constants, existsSync } from 'node:fs';
import { parseFlags } from './flags';
import { currentLock } from './lock';
import { pending } from './oplog';
import type { Report } from './report';
import { lastRunPath, type Job } from './schedule-launchd';
import { scheduleStatus } from './schedule';
import { loadSettings, statePath, type Settings } from './settings';
import { toolSteps } from './trim-steps';

type Severity = 'error' | 'warn' | 'info';
interface Problem {
	severity: Severity;
	what: string;
	fix: string;
}

/** Legacy `_management/disk` jobs → the atlas schedule that replaces each. */
const LEGACY: Record<string, Job> = { 'com.jurrejan.disk-autoclean': 'trim', 'com.jurrejan.disk-bloat': 'scan' };
const uid = () => process.getuid?.() ?? 501;
const loaded = (label: string) => Bun.spawnSync(['/bin/launchctl', 'print', `gui/${uid()}/${label}`]).exitCode === 0;

function scheduleProblems(s: Settings): Problem[] {
	return (['scan', 'trim'] as Job[]).flatMap((job): Problem[] => {
		const st = scheduleStatus(job, s);
		const out: Problem[] = [];
		if (st.problem) out.push({ severity: 'warn', what: `schedule ${job}: ${st.problem}`, fix: `atlas disk schedule ${st.enabled ? 'enable' : 'disable'} ${job}` });
		const r = st.lastRun;
		if (r && r.exit !== 0 && r.exit !== 2) out.push({ severity: 'warn', what: `schedule ${job}: last run ${r.finishedAt} ended ${r.result}`, fix: `read ${r.log} (state: ${lastRunPath(job)})` });
		return out;
	});
}

/** A legacy job only doubles up once its atlas schedule is on; until then it is the only one running. */
function legacyProblems(s: Settings): Problem[] {
	return Object.entries(LEGACY)
		.filter(([label]) => loaded(label))
		.map(([label, job]): Problem => {
			const bootout = `launchctl bootout gui/${uid()}/${label}`;
			return s.schedules[job].enabled
				? { severity: 'warn', what: `legacy job ${label} is still loaded — it would run a second ${job}`, fix: bootout }
				: { severity: 'info', what: `legacy job ${label} still runs the weekly ${job} (atlas's ${job} schedule is off)`, fix: `atlas disk schedule enable ${job}, then ${bootout}` };
		});
}

function archiveProblems(dir: string): Problem[] {
	if (!existsSync(dir)) return [{ severity: 'error', what: `archive location missing or unreachable: ${dir}`, fix: 'mount/create it, or `atlas disk config set archiveDir <path>`' }];
	try {
		accessSync(dir, constants.W_OK);
		return [];
	} catch {
		return [{ severity: 'error', what: `archive location not writable: ${dir}`, fix: 'fix its permissions, or `atlas disk config set archiveDir <path>`' }];
	}
}

function toolProblems(): Problem[] {
	const need: [string[], string][] = [[['tar', 'bsdtar'], 'archiving'], [['zstd'], 'archive compression'], [['git'], 'uncommitted/unpushed checks'], [['osascript'], 'notifications and Trash'], [['brctl'], 'iCloud upload state and downloads']];
	const core = need.filter(([alts]) => !alts.some((t) => Bun.which(t))).map(([alts, forWhat]): Problem => ({ severity: 'warn', what: `missing tool ${alts.join('/')} (for ${forWhat})`, fix: `install ${alts[0]}` }));
	const trim = [...new Set(toolSteps().flatMap((st) => st.needs))].filter((t) => !Bun.which(t)).map((t): Problem => ({ severity: 'info', what: `trim tool not installed: ${t} (its step is skipped)`, fix: `install ${t} if you use it` }));
	return [...core, ...trim];
}

function jobProblems(): Problem[] {
	const out: Problem[] = [];
	const open = pending();
	if (open.length) out.push({ severity: 'warn', what: `${open.length} interrupted operation(s)`, fix: 'atlas disk recover list' });
	const lock = currentLock();
	if (lock) out.push({ severity: 'info', what: `job '${lock.job}' is running (pid ${lock.pid}, since ${lock.since})`, fix: 'wait for it' });
	else if (existsSync(statePath('job.lock'))) out.push({ severity: 'warn', what: 'stale job lock (its process is gone)', fix: 'the next job takes it over; see `atlas disk recover list` for what it left' });
	return out;
}

const MARK: Record<Severity, string> = { error: '✗', warn: '⚠', info: '·' };

export async function run(args: string[]): Promise<Report> {
	parseFlags(args);
	const s = loadSettings();
	const problems = [...scheduleProblems(s), ...legacyProblems(s), ...archiveProblems(s.archiveDir), ...toolProblems(), ...jobProblems()];
	const serious = problems.filter((p) => p.severity !== 'info');
	const text = problems.length ? problems.map((p) => `${MARK[p.severity]} ${p.what}\n    fix: ${p.fix}`).join('\n') : '✓ no problems found';
	return { command: 'doctor', exit: serious.length ? 'partial' : 'ok', data: { problems }, text };
}
