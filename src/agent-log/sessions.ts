/**
 * Session and task bookkeeping for Agent Log v2. Sessions are the coordination
 * identity (boundary + actor); tasks carry the lease rationale and survive the
 * leases themselves. Both are created lazily on the first claim.
 */
import { createHash } from 'node:crypto';
import type { Database } from 'bun:sqlite';
import type { Workspace } from './project';
import { hashOf } from './project';
import type { LeaseRow, SessionRow, TaskRow } from './schema';

/** Session identity: stable per (boundary, actor) — the actor is the agent session id. */
export function sessionIdFor(workspace: Workspace, actor: string, explicit?: string): string {
	if (explicit) return explicit;
	return hashOf(`${workspace.id}|${actor}`);
}

export function sessionActor(db: Database, sessionId: string): string {
	const session = db.query('SELECT * FROM sessions WHERE id = ?').get(sessionId) as
		| SessionRow
		| null;
	return session?.actor ?? sessionId;
}

export function ensureSession(
	db: Database,
	boundaryId: string,
	sessionId: string,
	actor: string,
	now: number
): void {
	db.query(`INSERT OR IGNORE INTO sessions (id, boundary_id, actor, started_at, last_heartbeat, status)
		VALUES (?, ?, ?, ?, ?, 'active')`).run(sessionId, boundaryId, actor, now, now);
	db.query('UPDATE sessions SET last_heartbeat = ? WHERE id = ?').run(now, sessionId);
}

/** Attach to the session's newest open task, or open one titled by the rationale. */
export function ensureTask(
	db: Database,
	boundaryId: string,
	sessionId: string,
	explicit: string | undefined,
	fallbackTitle: string,
	now: number
): string {
	if (explicit) {
		db.query(`INSERT OR IGNORE INTO tasks (id, session_id, boundary_id, title, status, opened_at)
			VALUES (?, ?, ?, ?, 'open', ?)`).run(explicit, sessionId, boundaryId, fallbackTitle, now);
		return explicit;
	}
	const open = db
		.query(`SELECT * FROM tasks WHERE session_id = ? AND status = 'open' ORDER BY opened_at DESC LIMIT 1`)
		.get(sessionId) as TaskRow | null;
	if (open) return open.id;
	const id = `t-${createHash('sha256').update(`${sessionId}|${now}`).digest('hex').slice(0, 12)}`;
	db.query(`INSERT INTO tasks (id, session_id, boundary_id, title, status, opened_at)
		VALUES (?, ?, ?, ?, 'open', ?)`).run(id, sessionId, boundaryId, fallbackTitle.slice(0, 240), now);
	return id;
}

/** Live leases of a boundary — the conflict-check and read view use only these. */
export function activeLeases(db: Database, boundaryId: string, now: number): LeaseRow[] {
	return db
		.query('SELECT * FROM leases WHERE boundary_id = ? AND expires_ms > ?')
		.all(boundaryId, now) as LeaseRow[];
}

/** Crashed sessions' leases are removed at the start of every claim transaction. */
export function reapExpired(db: Database, boundaryId: string, now: number): void {
	db.query('DELETE FROM leases WHERE boundary_id = ? AND expires_ms <= ?').run(boundaryId, now);
}