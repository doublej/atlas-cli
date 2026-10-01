import { parseArgs } from 'node:util';
import type { Command } from '../types';
import { apiGet } from '../api';
import { die, requireUp } from '../util';
import { PROCESS_KINDS, type AppRow, type ProcessSnapshot } from '../processes';

const USAGE = `Usage: atlas ps [--project <q>] [--kind <kind>] [--all] [--json]

Processes on this Mac, one row per app (a process group folded into the process doing the work).
Default: development processes only.

  --project <q>  rows whose project name or slug contains <q>
  --kind <kind>  one kind: ${PROCESS_KINDS.join(', ')}
  --all          also apps and system rows
  --json         the API's rows, filtered and untruncated`;

export interface PsFilter {
	project?: string;
	kind?: string;
	all?: boolean;
}

/** The rows a filter shows, and how many more `--all` would add. */
export function selectRows(rows: AppRow[], f: PsFilter): { shown: AppRow[]; hidden: number } {
	const q = f.project?.toLowerCase();
	const matching = rows.filter(
		(r) =>
			(!f.kind || r.kind === f.kind) &&
			(!q || [r.project?.name, r.project?.slug].some((v) => v?.toLowerCase().includes(q)))
	);
	const shown = f.all ? matching : matching.filter((r) => r.dev);
	return { shown, hidden: matching.length - shown.length };
}

const mb = (bytes: number): string => `${Math.round(bytes / 1_048_576)}M`;
const age = (s: number): string =>
	s < 3600 ? `${Math.floor(s / 60)}m` : s < 86_400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86_400)}d`;

/** Dense table; COMMAND is cut to `width` so a row stays one line. */
export function renderPs(rows: AppRow[], snap: ProcessSnapshot, width: number): string[] {
	const command = new Map(snap.processes.map((p) => [p.pid, p.command]));
	const head = ['PID', 'KIND', 'PROJECT', 'PORTS', 'CPU', 'RSS', 'UP'];
	const cells = rows.map((r) => [
		String(r.primary),
		r.kind,
		r.project?.name ?? '-',
		r.ports.join(',') || '-',
		r.cpu.toFixed(1),
		mb(r.rss),
		age(r.uptime)
	]);
	const widths = head.map((h, i) => Math.max(h.length, ...cells.map((c) => c[i].length)));
	const pad = (c: string[]) => c.map((v, i) => v.padEnd(widths[i])).join('  ');
	const room = Math.max(20, width - pad(head).length - 2);
	const cut = (s: string) => (s.length > room ? `${s.slice(0, room - 1)}…` : s);
	return [
		`${pad(head)}  COMMAND`,
		...rows.map((r, i) => `${pad(cells[i])}  ${cut(command.get(r.primary) || r.name)}`)
	];
}

/** `atlas ps` — what runs on this Mac, by project, from GET /api/processes. */
export const ps: Command = {
	name: 'ps',
	summary: 'processes on this Mac by project (dev rows; --all for everything)',
	usage: USAGE,
	async run(args) {
		const { values } = parseArgs({
			args,
			options: {
				project: { type: 'string' },
				kind: { type: 'string' },
				all: { type: 'boolean' },
				json: { type: 'boolean' }
			}
		});
		if (values.kind && !(PROCESS_KINDS as readonly string[]).includes(values.kind))
			die(`Unknown kind "${values.kind}". Kinds: ${PROCESS_KINDS.join(', ')}`);
		await requireUp();
		const snap = await apiGet<ProcessSnapshot>('/api/processes?all=1');
		const { shown, hidden } = selectRows(snap.rows, values);
		if (values.json) return console.log(JSON.stringify(shown));
		if (shown.length) console.log(renderPs(shown, snap, process.stdout.columns ?? 80).join('\n'));
		else console.log('No matching processes.');
		console.log(`${shown.length} shown${hidden ? ` · ${hidden} hidden (--all)` : ''}`);
	}
};
