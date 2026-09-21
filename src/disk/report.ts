/**
 * Output contract. Every subcommand returns a Report; the router prints it as text or,
 * with `--json`, as one JSON object on stdout, and exits with the matching code.
 */
import { writeSync } from 'node:fs';
import type { Outcome } from './oplog';

export const EXIT = { ok: 0, error: 1, nothing: 2, partial: 3, refused: 4 } as const;
export type ExitName = keyof typeof EXIT;

export interface ItemReport {
	item: string;
	outcome: Outcome;
	/** Why it was skipped/refused/failed. */
	reason?: string;
	/** For a refusal: the approval or flag it needs. */
	needs?: string;
	[key: string]: unknown;
}

export interface Report {
	command: string;
	/** Overrides the exit derived from `items`. */
	exit?: ExitName;
	items?: ItemReport[];
	data?: unknown;
	/** Human rendering; omitted → a generic item list. */
	text?: string;
}

/** failed beats refused beats done; an empty batch is "nothing to do". */
export function exitFor(r: Report): ExitName {
	if (r.exit) return r.exit;
	const items = r.items ?? [];
	if (!items.length) return 'nothing';
	if (items.some((i) => i.outcome === 'failed')) return 'partial';
	if (items.some((i) => i.outcome === 'refused')) return items.some((i) => i.outcome === 'done') ? 'partial' : 'refused';
	return items.some((i) => i.outcome === 'done') ? 'ok' : 'nothing';
}

const MARK: Record<Outcome, string> = { done: '✓', skipped: '–', refused: '⊘', failed: '✗' };

export function renderItems(items: ItemReport[]): string {
	return items
		.map((i) => `${MARK[i.outcome]} ${i.outcome.padEnd(7)} ${i.item}${i.reason ? `  — ${i.reason}` : ''}${i.needs ? ` (needs ${i.needs})` : ''}`)
		.join('\n');
}

/**
 * Blocking write to stdout. @inquirer/prompts (imported by `atlas new`) leaves a piped stdout
 * non-blocking, and console.log then drops everything past 64 KB on EAGAIN.
 */
function writeOut(text: string): void {
	const buf = Buffer.from(`${text}\n`);
	for (let off = 0; off < buf.length; ) {
		try {
			off += writeSync(1, buf, off);
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== 'EAGAIN') throw e;
			Bun.sleepSync(1);
		}
	}
}

export function emit(r: Report, json: boolean): number {
	const exit = exitFor(r);
	// With nothing structured to show, the text is the message (e.g. why it was refused).
	const message = r.items || r.data !== undefined ? undefined : r.text;
	if (json) writeOut(JSON.stringify({ command: r.command, exit, message, items: r.items, data: r.data }, null, 2));
	else {
		const out = r.text ?? (r.items?.length ? renderItems(r.items) : exit === 'nothing' ? 'Nothing to do.' : '');
		if (out) writeOut(out);
	}
	return EXIT[exit];
}
