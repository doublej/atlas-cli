/**
 * Merge-idempotent installer for Claude Code hook commands in a settings.json.
 * Matches on the exact command string, preserves every unrelated entry (other
 * events, other matchers, other commands), and only writes when something changed.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

type HookCommand = { type: 'command'; command: string };
type HookEntry = { matcher?: string; hooks?: HookCommand[] };
type Settings = { hooks?: Record<string, HookEntry[]> } & Record<string, unknown>;

/** Returns true when the hook was added, false when it was already present. */
export function installHook(settingsPath: string, event: string, command: string): boolean {
	const settings: Settings = existsSync(settingsPath)
		? (JSON.parse(readFileSync(settingsPath, 'utf8')) as Settings)
		: {};
	const events = (settings.hooks ??= {});
	const entries = (events[event] ??= []);
	const present = entries.some((entry) => entry.hooks?.some((hook) => hook.command === command));
	if (present) return false;
	entries.push({ hooks: [{ type: 'command', command }] });
	writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
	return true;
}
