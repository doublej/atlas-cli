import { resolve } from 'node:path';
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

const daemonTarget = () => `gui/${process.getuid?.() ?? 0}/com.jurrejan.atlas-api`;

/** Nudge the atlas-api launchd daemon back to life (no-op if it isn't loaded). */
async function kickstart(): Promise<void> {
	await Bun.spawn(['launchctl', 'kickstart', '-k', daemonTarget()], {
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

/** Like `ensureUp()`, but dies with a hint when the self-heal fails. */
export async function requireUp(): Promise<void> {
	if (!(await ensureUp())) die(`atlas-api still isn't up. Check: launchctl print ${daemonTarget()}`);
}
