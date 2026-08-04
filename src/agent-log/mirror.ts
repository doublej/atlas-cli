/** Plain-text mirror of journal writes for Console.app (~/Library/Logs is auto-listed there). */
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import type { EventRow } from './store';

const LOG_DIR = join(homedir(), 'Library', 'Logs', 'atlas');
const LOG_PATH = join(LOG_DIR, 'agent-log.log');

function localStamp(ms: number): string {
	const d = new Date(ms);
	const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
	return `${date} ${d.toTimeString().slice(0, 8)}`;
}

function formatLine(row: EventRow): string {
	const scopes = (JSON.parse(row.scopes) as string[]).join(', ');
	const parts = [
		localStamp(row.at_ms),
		row.kind.toUpperCase().padEnd(7),
		`[${basename(process.cwd())}]`,
		row.actor,
		row.operation || '-',
		row.summary,
		`[${scopes}]`
	];
	if (row.outcome) parts.push(`outcome=${row.outcome}`);
	return parts.join(' ') + '\n';
}

/** `agent-log console` — open the mirror log in Console.app (creates it empty if needed). */
export async function openConsole(): Promise<void> {
	mkdirSync(LOG_DIR, { recursive: true });
	appendFileSync(LOG_PATH, '');
	await Bun.spawn(['open', '-a', 'Console', LOG_PATH], {
		stdout: 'inherit',
		stderr: 'inherit'
	}).exited;
}

/** Best-effort append; a mirror failure must never fail the journal write itself. */
export function mirrorEvent(row: EventRow): void {
	// Skip when the db location is overridden (tests, sandboxes) — mirror the real journals only.
	if (process.env.ATLAS_AGENT_LOG_PATH) return;
	try {
		mkdirSync(LOG_DIR, { recursive: true });
		appendFileSync(LOG_PATH, formatLine(row));
	} catch {
		// e.g. sandboxed or read-only home — the sqlite journal is the source of truth.
	}
}
