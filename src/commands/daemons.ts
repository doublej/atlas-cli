import type { Command } from '../types';
import { apiGet, apiPost } from '../api';
import { die, requireUp } from '../util';

/** One `GET /api/daemons` entry: the `shared/daemons.json` record plus its live state. */
export interface Daemon {
	label: string;
	name: string;
	port?: number;
	selfManaged?: boolean;
	state: { pid: number | null; lastExitStatus: number | null; status: string };
	scheduled: boolean;
	portInUse: boolean | null;
	stale: boolean;
}

const USAGE = `Usage: atlas daemons [--json]             the launchd daemons atlas manages (shared/daemons.json)
       atlas daemons restart <label> [--json]   restart one; <label> may be a unique part of its label or name

atlas-api is self-managed and refused: the CLI and atlas-watchdog bring it back themselves.`;

function render(daemons: Daemon[]): string[] {
	const nw = Math.max(...daemons.map((d) => d.name.length));
	const lw = Math.max(...daemons.map((d) => d.label.length));
	return daemons.map((d) => {
		const s = d.state;
		const status = s.pid ? `running ${s.pid}` : s.status === 'error' ? `error (exit ${s.lastExitStatus})` : s.status;
		const port = d.port ? `:${d.port}${d.portInUse === false ? ' (not listening)' : ''}` : '';
		const flags = [d.stale && 'stale', d.scheduled && 'scheduled', d.selfManaged && 'self-managed'].filter(Boolean);
		return [d.name.padEnd(nw), d.label.padEnd(lw), status.padEnd(14), port, flags.join(' ')].join('  ').trimEnd();
	});
}

/** An exact label, else the one daemon whose label or name contains `q`. Dies otherwise. */
export function pickDaemon(daemons: Daemon[], q: string): Daemon {
	const exact = daemons.find((d) => d.label === q);
	if (exact) return exact;
	const lq = q.toLowerCase();
	const hits = daemons.filter((d) => d.label.toLowerCase().includes(lq) || d.name.toLowerCase().includes(lq));
	if (hits.length === 1) return hits[0];
	const list = (ds: Daemon[]) => ds.map((d) => `  ${d.label}  (${d.name})`).join('\n');
	return die(hits.length ? `"${q}" matches several daemons:\n${list(hits)}` : `No daemon matches "${q}". Labels:\n${list(daemons)}`);
}

async function restart(q: string, json: boolean): Promise<void> {
	const { daemons } = await apiGet<{ daemons: Daemon[] }>('/api/daemons');
	const d = pickDaemon(daemons, q);
	if (d.selfManaged)
		die(`${d.label} is self-managed: never restart it from here. The CLI self-heals it; atlas-watchdog supervises it.`);
	const res = await apiPost<{ action: string; state: Daemon['state'] }>(
		`/api/daemons/${encodeURIComponent(d.label)}`,
		{ action: 'restart' }
	);
	console.log(json ? JSON.stringify(res) : `restarted ${d.name} — ${res.state.pid ? `running ${res.state.pid}` : res.state.status}`);
}

/** `atlas daemons` — the launchd daemons from shared/daemons.json, live; `restart` kicks one. */
export const daemons: Command = {
	name: 'daemons',
	summary: 'launchd daemons atlas manages: list, `restart <label>`',
	usage: USAGE,
	async run(args) {
		const json = args.includes('--json');
		const [sub, label, ...extra] = args.filter((a) => !a.startsWith('-'));
		if (sub && (sub !== 'restart' || !label || extra.length)) die(USAGE);
		await requireUp();
		if (sub) return restart(label, json);
		const list = (await apiGet<{ daemons: Daemon[] }>('/api/daemons')).daemons;
		console.log(json ? JSON.stringify(list) : render(list).join('\n'));
	}
};
