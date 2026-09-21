/**
 * The two weekly launchd jobs. Plists are generated from `settings.schedules` into
 * `atlas-cli/launchd/`, symlinked from ~/Library/LaunchAgents and (un)loaded with launchctl.
 * Tests redirect all three: ATLAS_DISK_PLIST_DIR, ATLAS_DISK_LAUNCH_AGENTS, ATLAS_DISK_LAUNCHCTL.
 */
import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { statePath, type Schedule } from './settings';

export type Job = 'scan' | 'trim';
export const JOBS: Record<Job, { label: string; args: string[] }> = {
	scan: { label: 'com.jurrejan.atlas-disk-scan', args: ['scan', '--scheduled', '--notify'] },
	trim: { label: 'com.jurrejan.atlas-disk-trim', args: ['trim', '--scheduled'] }
};

const REPO_LAUNCHD = join(realpathSync(import.meta.dir), '..', '..', 'launchd');
export const WRAPPER = join(REPO_LAUNCHD, 'atlas-disk-job.sh');
export const LOG_DIR = join(homedir(), 'Library', 'Logs', 'atlas-disk');
const plistDir = () => process.env.ATLAS_DISK_PLIST_DIR ?? REPO_LAUNCHD;
const agentsDir = () => process.env.ATLAS_DISK_LAUNCH_AGENTS ?? join(homedir(), 'Library', 'LaunchAgents');
export const plistPath = (job: Job) => join(plistDir(), `${JOBS[job].label}.plist`);
export const linkPath = (job: Job) => join(agentsDir(), `${JOBS[job].label}.plist`);
export const lastRunPath = (job: Job) => statePath(`schedule-${job}.json`);

function launchctl(...args: string[]): { ok: boolean; out: string } {
	const r = Bun.spawnSync([process.env.ATLAS_DISK_LAUNCHCTL ?? '/bin/launchctl', ...args]);
	return { ok: r.exitCode === 0, out: `${r.stdout}${r.stderr}`.trim() };
}
const domain = () => `gui/${process.getuid?.() ?? 501}`;

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const str = (s: string) => `<string>${esc(s)}</string>`;
const int = (k: string, n: number) => `\t\t<key>${k}</key>\n\t\t<integer>${n}</integer>`;

export function plistXml(job: Job, s: Schedule): string {
	const env: [string, string][] = [['HOME', homedir()]];
	if (process.env.ATLAS_DISK_HOME) env.push(['ATLAS_DISK_HOME', process.env.ATLAS_DISK_HOME]);
	const log = join(LOG_DIR, `launchd.${job}.log`);
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	${str(JOBS[job].label)}
	<key>ProgramArguments</key>
	<array>
${[WRAPPER, job, ...JOBS[job].args].map((a) => `\t\t${str(a)}`).join('\n')}
	</array>
	<key>StartCalendarInterval</key>
	<dict>
${int('Weekday', s.weekday)}
${int('Hour', s.hour)}
${int('Minute', s.minute)}
	</dict>
	<key>RunAtLoad</key>
	<false/>
	<key>StandardOutPath</key>
	${str(log)}
	<key>StandardErrorPath</key>
	${str(log)}
	<key>ProcessType</key>
	<string>Background</string>
	<key>LowPriorityIO</key>
	<true/>
	<key>Nice</key>
	<integer>10</integer>
	<key>EnvironmentVariables</key>
	<dict>
${env.map(([k, v]) => `\t\t<key>${k}</key>\n\t\t${str(v)}`).join('\n')}
	</dict>
</dict>
</plist>
`;
}

export const isLoaded = (job: Job): boolean => launchctl('print', `${domain()}/${JOBS[job].label}`).ok;

/** Write the plist, (re)link it and (re)load it. Returns an error message, or null. */
export function install(job: Job, s: Schedule): string | null {
	mkdirSync(plistDir(), { recursive: true });
	mkdirSync(agentsDir(), { recursive: true });
	mkdirSync(LOG_DIR, { recursive: true });
	writeFileSync(plistPath(job), plistXml(job, s));
	if (isLoaded(job)) launchctl('bootout', `${domain()}/${JOBS[job].label}`);
	rmSync(linkPath(job), { force: true });
	symlinkSync(plistPath(job), linkPath(job));
	const r = launchctl('bootstrap', domain(), linkPath(job));
	return r.ok ? null : `launchctl bootstrap failed: ${r.out}`;
}

export function uninstall(job: Job): void {
	if (isLoaded(job)) launchctl('bootout', `${domain()}/${JOBS[job].label}`);
	rmSync(linkPath(job), { force: true });
}

export interface LastRun {
	exit: number;
	startedAt: string;
	finishedAt: string;
	log: string;
}

export function lastRun(job: Job): LastRun | null {
	return existsSync(lastRunPath(job)) ? (JSON.parse(readFileSync(lastRunPath(job), 'utf8')) as LastRun) : null;
}

/** Where the LaunchAgents link points, null when there is no link (or a plain file). */
export function linkTarget(job: Job): string | null {
	try {
		return lstatSync(linkPath(job)).isSymbolicLink() ? readlinkSync(linkPath(job)) : null;
	} catch {
		return null;
	}
}

/** The generated plist on disk matches what the settings would generate now. */
export const plistCurrent = (job: Job, s: Schedule): boolean => existsSync(plistPath(job)) && readFileSync(plistPath(job), 'utf8') === plistXml(job, s);
