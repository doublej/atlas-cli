/**
 * `agent-log status` — the compact state snapshot humans and agents read:
 * task, peers, owned/conflicting leases, valid findings, and the next action
 * (latest handoff). Reads state, never writes. `recent` stays the forensic view.
 */
import { basename } from 'node:path';
import { formatAge } from '../brief-format';
import type { Workspace } from './project';
import { activeLeases, sessionActor } from './sessions';
import { openJournal, type SessionRow, type TaskRow } from './schema';
import { conflictsWith } from './scopes';

export type StatusData = {
	project: { id: string; root: string; mode: string; boundary: string };
	session: { id: string; actor: string; startedAt: number; status: string; leases: number } | null;
	task: { id: string; title: string; openedAt: number } | null;
	owned: { scope: string; type: string; expiresAt: number; generation: number; task: string }[];
	conflicts: { scope: string; session: string; actor: string; expiresAt: number }[];
	peers: { actor: string; leases: number }[];
	findings: { summary: string; atMs: number }[];
	handoff: { summary: string; atMs: number } | null;
};

export function gatherStatus(workspace: Workspace, sessionId: string | null): StatusData {
	const db = openJournal(workspace);
	try {
		const now = Date.now();
		const leases = activeLeases(db, workspace.id, now);
		const owned = leases.filter((lease) => lease.session_id === sessionId);
		const conflicts = leases.filter(
			(lease) =>
				lease.session_id !== sessionId &&
				owned.some((own) =>
					conflictsWith(
						{ type: own.scope_type, normalized: own.normalized },
						{ type: lease.scope_type, normalized: lease.normalized }
					)
				)
		);
		const session = sessionId
			? (db.query('SELECT * FROM sessions WHERE id = ?').get(sessionId) as SessionRow | null)
			: null;
		const task = sessionId
			? (db
					.query(`SELECT * FROM tasks WHERE session_id = ? AND status = 'open' ORDER BY opened_at DESC LIMIT 1`)
					.get(sessionId) as TaskRow | null)
			: null;
		const sessions = db.query(`SELECT * FROM sessions WHERE status = 'active'`).all() as SessionRow[];
		const peers = sessions
			.filter((row) => row.id !== sessionId)
			.map((row) => ({
				actor: row.actor,
				leases: leases.filter((lease) => lease.session_id === row.id).length
			}))
			.filter((peer) => peer.leases > 0);
		const findings = (
			db
				.query('SELECT summary, at_ms FROM events WHERE kind = ? AND expires_ms >= ?')
				.all('finding', now) as { summary: string; at_ms: number }[]
		).map((row) => ({ summary: row.summary, atMs: row.at_ms }));
		const handoffRow = db
			.query('SELECT summary, at_ms FROM events WHERE kind = ? ORDER BY seq DESC LIMIT 1')
			.get('handoff') as { summary: string; at_ms: number } | null;
		return {
			project: {
				id: workspace.id,
				root: workspace.root,
				mode: workspace.mode,
				boundary: workspace.boundary
			},
			session: session
				? {
						id: session.id,
						actor: session.actor,
						startedAt: session.started_at,
						status: session.status,
						leases: owned.length
					}
				: null,
			task: task ? { id: task.id, title: task.title, openedAt: task.opened_at } : null,
			owned: owned.map((lease) => ({
				scope: lease.scope,
				type: lease.scope_type,
				expiresAt: lease.expires_ms,
				generation: lease.generation,
				task: lease.task_id
			})),
			conflicts: conflicts.map((lease) => ({
				scope: lease.scope,
				session: lease.session_id,
				actor: sessionActor(db, lease.session_id),
				expiresAt: lease.expires_ms
			})),
			peers,
			findings,
			handoff: handoffRow ? { summary: handoffRow.summary, atMs: handoffRow.at_ms } : null
		};
	} finally {
		db.close();
	}
}

const fmtRemaining = (expiresMs: number, nowMs: number): string =>
	`${Math.max(1, Math.round((expiresMs - nowMs) / 60_000))}m`;

export function renderStatus(data: StatusData, nowMs: number): string {
	const age = (ms: number): string => formatAge(ms, nowMs);
	const lines = [
		`atlas agent-log status — ${basename(data.project.root)} (${data.project.mode}, ${data.project.boundary})`
	];
	if (data.session)
		lines.push(
			`  session:  ${data.session.id} · ${data.session.actor} · started ${age(data.session.startedAt)} · ${data.session.leases} lease(s)`
		);
	if (data.task) lines.push(`  task:     ${data.task.title} (opened ${age(data.task.openedAt)})`);
	if (data.owned.length) {
		lines.push('  owned:');
		for (const lease of data.owned)
			lines.push(
				`    ${lease.scope.padEnd(28)} expires in ${fmtRemaining(lease.expiresAt, nowMs)} · gen ${lease.generation}`
			);
	}
	if (data.conflicts.length) {
		lines.push('  conflicts:');
		for (const conflict of data.conflicts)
			lines.push(
				`    ${conflict.scope.padEnd(28)} held by ${conflict.actor} until ${new Date(conflict.expiresAt).toTimeString().slice(0, 8)}`
			);
	}
	if (data.peers.length)
		lines.push(`  peers:    ${data.peers.map((peer) => `${peer.actor} (${peer.leases})`).join(', ')}`);
	if (data.findings.length) lines.push(`  findings: ${data.findings.length} valid`);
	if (data.handoff) lines.push(`  handoff:  ${data.handoff.summary} (${age(data.handoff.atMs)})`);
	return lines.join('\n');
}