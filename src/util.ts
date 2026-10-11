import { basename, resolve } from 'node:path';
import { API_BASE, isUp } from './api';

/** Print to stderr and exit non-zero. */
export function die(msg: string): never {
	console.error(msg);
	process.exit(1);
}

/** The folder a command acts on: an explicit path arg, else the current directory. */
export const resolveRoot = (arg?: string): string => (arg ? resolve(arg) : process.cwd());

/** Open a URL in the default browser (macOS `open`). */
export async function openUrl(url: string): Promise<void> {
	await Bun.spawn(['open', url], { stdout: 'inherit', stderr: 'inherit' }).exited;
}

/** Single-quote a value so the parent shell takes it literally. */
export const shellQuote = (s: string): string => `'${s.replaceAll("'", `'\\''`)}'`;

/** The shell line that lands the user in `dir`: cd + the one-line confirmation. */
export const cdLine = (dir: string): string =>
	`cd ${shellQuote(dir)} && echo ${shellQuote(`→ ${basename(dir)}`)}`;

/**
 * Hand a command line to the parent shell. A child process can't cd (or run anything)
 * in the shell that spawned it, so the `atlas` zsh wrapper (`shell/atlas.zsh`) passes
 * `$ATLAS_SHELL_FILE` and evals whatever we write there. Without the wrapper, print the
 * line so it stays copy-pasteable (or `eval "$(atlas …)"`-able).
 */
export async function shellExec(line: string): Promise<void> {
	const file = process.env.ATLAS_SHELL_FILE;
	if (file) await Bun.write(file, `${line}\n`);
	else console.log(line);
}

const daemonTarget = () => `gui/${process.getuid?.() ?? 0}/com.jurrejan.atlas-api`;

/**
 * Nudge the atlas-api launchd daemon back to life (no-op if it isn't loaded).
 *
 * Deliberately no `-k`: that SIGKILLs the job even when it is alive and merely slow to
 * answer, which is how a booting server got killed on every poll and never converged.
 * Plain `kickstart` starts a dead job and leaves a live one alone; the plist's
 * `KeepAlive` already restarts anything that actually exits.
 */
async function kickstart(): Promise<void> {
	await Bun.spawn(['launchctl', 'kickstart', daemonTarget()], {
		stdout: 'ignore',
		stderr: 'ignore'
	}).exited;
}

/** If atlas-api isn't reachable, try to restart its launchd daemon. Returns whether it's up. */
export async function ensureUp(): Promise<boolean> {
	if (await isUp()) return true;
	console.error(`atlas-api isn't running (${API_BASE}) — restarting it…`);
	await kickstart();
	for (let i = 0; i < 15; i++) {
		if (await isUp()) return true;
		await Bun.sleep(300);
	}
	return false;
}

/**
 * Why the daemon isn't serving, from `launchctl print` output (null = job not loaded) and the
 * last line of its stderr log. Pure, so it is testable without launchd.
 */
export function explainDown(print: string | null, lastError?: string): string {
	const target = daemonTarget();
	if (print === null)
		return `atlas-api isn't loaded in launchd (${target}).\n  Load it: launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.jurrejan.atlas-api.plist`;
	const field = (key: string) => print.match(new RegExp(`^\\s*${key} = (.+)$`, 'm'))?.[1];
	const lines = [
		`atlas-api still isn't up — launchd started it ${field('runs') ?? '?'} times, last exit code ${field('last exit code') ?? '?'}.`
	];
	if (lastError) lines.push(`  ${field('stderr path')}: ${lastError}`);
	if (lastError?.includes('build/index.js'))
		lines.push(`  The build is missing or half-written. Rebuild: cd ${field('working directory')} && bun run daemon:reload`);
	lines.push(`  More: launchctl print ${target}`);
	return lines.join('\n');
}

/** Read launchd's record of the daemon and the tail of its stderr log, then explain. */
async function diagnoseDown(): Promise<string> {
	const p = Bun.spawnSync(['launchctl', 'print', daemonTarget()]);
	if (p.exitCode !== 0) return explainDown(null);
	const print = p.stdout.toString();
	const errPath = print.match(/^\s*stderr path = (.+)$/m)?.[1];
	const log = errPath && (await Bun.file(errPath).exists()) ? await Bun.file(errPath).slice(-4096).text() : '';
	return explainDown(print, log.trim().split('\n').at(-1) || undefined);
}

/** Like `ensureUp()`, but dies with the daemon's own failure reason when the self-heal fails. */
export async function requireUp(): Promise<void> {
	if (!(await ensureUp())) die(await diagnoseDown());
}
