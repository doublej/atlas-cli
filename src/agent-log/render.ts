/** Read-side: filter live rows and print `agent-log recent`. */
import { type Options, parseDuration } from './args';
import { type EventRow, loadEvents } from './store';

export function visibleRows(options: Options): EventRow[] {
	const now = Date.now();
	const since = now - parseDuration(options.get('--since')?.[0] ?? '30m');
	const rows = loadEvents();
	const ended = new Set(rows.filter((row) => row.kind === 'end').map((row) => row.op_id));
	const scope = options.get('--scope')?.[0];
	const scoped = scope
		? rows.filter((row) => (JSON.parse(row.scopes) as string[]).includes(scope))
		: rows;
	// The latest handoff is always visible (it's the durable session baton);
	// older handoffs age out on the same --since window as ends and transitions.
	const latestHandoff = scoped.findLast((row) => row.kind === 'handoff');
	return scoped.filter((row) => {
		if (row.kind === 'intent') return !ended.has(row.op_id) && (row.expires_ms ?? 0) >= now;
		if (row.kind === 'handoff') return row === latestHandoff || row.at_ms >= since;
		return row.kind === 'end' || row.kind === 'transition'
			? row.at_ms >= since
			: (row.expires_ms ?? 0) >= now;
	});
}

function renderDetail(row: EventRow): string {
	const detail = JSON.parse(row.detail) as Record<string, unknown>;
	const parts = [`head=${detail.head}`, `dirty=${detail.dirty}`];
	if (row.expires_ms) parts.push(`expires=${new Date(row.expires_ms).toISOString()}`);
	if (detail.evidence) parts.push(`evidence=${JSON.stringify(detail.evidence)}`);
	if (detail.duration_ms !== undefined) parts.push(`duration_ms=${detail.duration_ms}`);
	if (detail.exit_code !== undefined) parts.push(`exit=${detail.exit_code}`);
	if (detail.session_id) parts.push(`session=${detail.session_id}`);
	if (row.outcome) parts.push(`outcome=${row.outcome}`);
	return parts.join(' ');
}

export type ParsedEvent = Omit<EventRow, 'scopes' | 'detail'> & {
	scopes: string[];
	detail: Record<string, unknown>;
};

/** Row with the two JSON-in-TEXT columns parsed — the machine-readable shape. */
export function parseRow(row: EventRow): ParsedEvent {
	return {
		...row,
		scopes: JSON.parse(row.scopes) as string[],
		detail: JSON.parse(row.detail) as Record<string, unknown>
	};
}

export function recent(options: Options, asJson = false): void {
	const rows = visibleRows(options);
	if (asJson) {
		console.log(JSON.stringify(rows.map(parseRow)));
		return;
	}
	if (rows.length === 0) {
		console.log('agent-log: no relevant events');
		return;
	}
	for (const row of rows) {
		const state = row.kind === 'intent' ? 'ACTIVE' : row.kind.toUpperCase();
		const time = new Date(row.at_ms).toTimeString().slice(0, 8);
		const scopes = (JSON.parse(row.scopes) as string[]).join(', ');
		console.log(
			`${state} ${time} ${row.actor} ${row.operation || '-'} ${row.summary} [${scopes}] ${renderDetail(row)}`
		);
	}
}
