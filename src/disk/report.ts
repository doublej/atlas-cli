/**
 * Output contract. Every subcommand returns a Report; the router prints it as text or,
 * with `--json`, as one JSON object on stdout, and exits with the matching code.
 */
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
	return 'ok';
}

const MARK: Record<Outcome, string> = { done: '✓', skipped: '–', refused: '⊘', failed: '✗' };

export function renderItems(items: ItemReport[]): string {
	return items
		.map((i) => `${MARK[i.outcome]} ${i.outcome.padEnd(7)} ${i.item}${i.reason ? `  — ${i.reason}` : ''}${i.needs ? ` (needs ${i.needs})` : ''}`)
		.join('\n');
}

export function emit(r: Report, json: boolean): number {
	const exit = exitFor(r);
	if (json) console.log(JSON.stringify({ command: r.command, exit, items: r.items, data: r.data }, null, 2));
	else {
		const out = r.text ?? (r.items?.length ? renderItems(r.items) : exit === 'nothing' ? 'Nothing to do.' : '');
		if (out) console.log(out);
	}
	return EXIT[exit];
}
