/**
 * Agent Log v2 leases: exclusive write scopes with re-entrant renewal and expiry
 * recovery. Claims are atomic: one BEGIN IMMEDIATE transaction reaps expired
 * leases, tests every requested scope for overlap, then inserts or extends all.
 */
import type { Database } from 'bun:sqlite';
import type { Workspace } from './project';
import { openJournal, type LeaseRow } from './schema';
import { conflictsWith, expandAliases, normalizeScope, type NormalizedScope } from './scopes';
import { activeLeases, ensureSession, ensureTask, reapExpired, sessionActor } from './sessions';

export const DEFAULT_TTL_MS = 20 * 60_000;

export type ClaimInput = {
	workspace: Workspace;
	sessionId: string;
	actor: string;
	scopes: string[];
	rationale: string;
	ttlMs?: number;
	taskId?: string;
	now?: number;
};

export type ClaimResult =
	| { ok: true; leases: LeaseRow[] }
	| {
			ok: false;
			conflicts: { scope: string; sessionId: string; actor: string; expiresMs: number }[];
	  };

function grantLease(
	db: Database,
	workspace: Workspace,
	request: NormalizedScope,
	sessionId: string,
	taskId: string,
	now: number,
	ttlMs: number,
	rationale: string
): void {
	const existing = db
		.query('SELECT * FROM leases WHERE boundary_id = ? AND session_id = ? AND normalized = ?')
		.get(workspace.id, sessionId, request.normalized) as LeaseRow | null;
	if (existing) {
		// Re-entrant renewal: same grant epoch, heartbeat + expiry extended.
		db.query(
			'UPDATE leases SET heartbeat_ms = ?, expires_ms = ?, rationale = ?, task_id = ? WHERE id = ?'
		).run(now, now + ttlMs, rationale, taskId, existing.id);
		return;
	}
	const generation = (
		db.query('SELECT COALESCE(MAX(generation), 0) AS g FROM leases').get() as { g: number }
	).g + 1;
	db.query(
		`INSERT INTO leases (boundary_id, scope, scope_type, normalized, session_id, task_id,
			generation, heartbeat_ms, expires_ms, rationale)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
	).run(
		workspace.id,
		request.scope,
		request.type,
		request.normalized,
		sessionId,
		taskId,
		generation,
		now,
		now + ttlMs,
		rationale
	);
}

/**
 * Acquire (or extend) leases atomically. Re-entrant for the same session: an
 * existing lease is renewed in place (same generation — the grant epoch is
 * unchanged); any ownership change later gets a fresh, higher generation.
 */
export function claimScopes(input: ClaimInput): ClaimResult {
	if (!input.rationale) throw new Error('a rationale is required');
	if (input.rationale.length > 240) throw new Error('rationale must be 240 characters or fewer');
	const now = input.now ?? Date.now();
	const ttlMs = input.ttlMs ?? DEFAULT_TTL_MS;
	const requests: NormalizedScope[] = expandAliases(input.scopes, input.workspace.aliases).map(
		(scope) => normalizeScope(scope, input.workspace.root)
	);
	if (requests.length === 0) throw new Error('scopes expand to nothing');
	const db = openJournal(input.workspace);
	try {
		db.exec('BEGIN IMMEDIATE');
		try {
			reapExpired(db, input.workspace.id, now);
			const heldByOthers = activeLeases(db, input.workspace.id, now).filter(
				(lease) => lease.session_id !== input.sessionId
			);
			for (const request of requests) {
				const conflict = heldByOthers.find((lease) =>
					conflictsWith(
						{ type: lease.scope_type, normalized: lease.normalized },
						request
					)
				);
				if (conflict) {
					db.exec('ROLLBACK');
					return {
						ok: false,
						conflicts: [
							{
								scope: conflict.scope,
								sessionId: conflict.session_id,
								actor: sessionActor(db, conflict.session_id),
								expiresMs: conflict.expires_ms
							}
						]
					};
				}
			}
			ensureSession(db, input.workspace.id, input.sessionId, input.actor, now);
			const taskId = ensureTask(
				db,
				input.workspace.id,
				input.sessionId,
				input.taskId,
				input.rationale,
				now
			);
			const seen = new Set<string>();
			for (const request of requests) {
				if (seen.has(request.normalized)) continue;
				seen.add(request.normalized);
				grantLease(db, input.workspace, request, input.sessionId, taskId, now, ttlMs, input.rationale);
			}
			db.exec('COMMIT');
			const claimed = new Set(requests.map((request) => request.normalized));
			const leases = activeLeases(db, input.workspace.id, now).filter(
				(lease) => lease.session_id === input.sessionId && claimed.has(lease.normalized)
			);
			return { ok: true, leases };
		} catch (error) {
			db.exec('ROLLBACK');
			throw error;
		}
	} finally {
		db.close();
	}
}