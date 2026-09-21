/** The weekly space warning: when to raise it, and the alert with its Review button. */
import { homedir } from 'node:os';
import { human } from './fsutil';
import type { Settings } from './settings';
import type { Scan } from './types';

const GB = 1024 ** 3;

/** Why to warn, or null: the total reached the limit, or grew past the growth limit since the previous scan. */
export function warnReason(total: number, previous: number | null, s: Pick<Settings, 'notifyTotalGB' | 'notifyGrowthGB'>): string | null {
	if (total >= s.notifyTotalGB * GB) return `${human(total)} reclaimable (limit ${s.notifyTotalGB} GB)`;
	if (previous !== null && total - previous > s.notifyGrowthGB * GB) return `${human(total)} reclaimable, up ${human(total - previous)} since the last scan`;
	return null;
}

const short = (p: string) => p.replace(homedir(), '~');

/**
 * Chosen approach: `display alert` via osascript. It is the only built-in macOS notification with
 * buttons (`display notification` has none, and alerter/terminal-notifier aren't installed). It is
 * modal, so it gives up after an hour. Review opens Terminal on the cleanup list.
 */
export function notify(reason: string, scan: Scan): void {
	const top = scan.folders
		.filter((f) => !f.nested)
		.slice(0, 3)
		.map((f) => `${human(f.bytes)}  ${short(f.path)}`)
		.join('\n');
	const script = [
		'on run argv',
		'set r to display alert "Disk space is building up" message (item 1 of argv) buttons {"Dismiss", "Review"} default button "Review" giving up after 3600',
		'if button returned of r is "Review" then',
		'tell application "Terminal" to do script "atlas disk clean"',
		'tell application "Terminal" to activate',
		'end if',
		'end run'
	].flatMap((l) => ['-e', l]);
	Bun.spawnSync(['osascript', ...script, `${reason}\n\nBiggest folders:\n${top}`], { stderr: 'ignore' });
}
