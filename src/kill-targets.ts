// What `atlas kill <pid | :port | project>` means, as pid + start time pairs. Pure over API answers.
import type { ProcessSnapshot, StopTarget } from './processes';

export interface NamedTarget extends StopTarget {
	name: string;
}

/** One `/api/ports/listeners` entry, as far as kill reads it (`startedAt` per contract C.1). */
export interface ListenerRef {
	port: number;
	pid: number;
	name: string;
	startedAt: string;
}

export type TargetKind = 'pid' | 'port' | 'project';

export const targetKind = (t: string): TargetKind =>
	/^\d+$/.test(t) ? 'pid' : /^:\d+$/.test(t) ? 'port' : 'project';

const unique = (ts: NamedTarget[]): NamedTarget[] =>
	ts.filter((t, i) => ts.findIndex((u) => u.pid === t.pid) === i);

export function pidTargets(snap: ProcessSnapshot, pid: number): NamedTarget[] {
	const p = snap.processes.find((x) => x.pid === pid);
	return p ? [{ pid, startedAt: p.startedAt, name: p.name }] : [];
}

export const portTargets = (listeners: ListenerRef[], port: number): NamedTarget[] =>
	unique(
		listeners.filter((l) => l.port === port).map((l) => ({ pid: l.pid, startedAt: l.startedAt, name: l.name }))
	);

/**
 * Every member of every row of one project: an exact name/slug first, else a substring of either
 * (as `atlas ps --project`). Several projects matching is ambiguous — `candidates` lists them.
 */
export function projectTargets(
	snap: ProcessSnapshot,
	query: string
): { targets: NamedTarget[]; candidates: string[] } {
	const q = query.toLowerCase();
	const owned = snap.rows.filter((r) => r.project);
	const names = (r: (typeof owned)[number]) => [r.project!.name, r.project!.slug].map((v) => v?.toLowerCase());
	const exact = owned.filter((r) => names(r).includes(q));
	const rows = exact.length ? exact : owned.filter((r) => names(r).some((v) => v?.includes(q)));
	const candidates = [...new Set(rows.map((r) => r.project!.path))];
	if (candidates.length > 1) return { targets: [], candidates };
	const byPid = new Map(snap.processes.map((p) => [p.pid, p]));
	const targets = rows.flatMap((r) =>
		r.pids.flatMap((pid) => {
			const p = byPid.get(pid);
			return p ? [{ pid, startedAt: p.startedAt, name: p.name }] : [];
		})
	);
	return { targets: unique(targets), candidates };
}
