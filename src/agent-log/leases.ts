/**
 * Agent Log v2 leases: exclusive write scopes with re-entrant renewal and expiry
 * recovery. Claims are atomic: one BEGIN IMMEDIATE transaction reaps expired
 * leases, tests every requested scope for overlap, then inserts or extends all.
 * Path leases are per-worktree (looser); refs, remotes, ports, and services stay
 * shared. Forced takeover deletes the conflicting leases, audits who/why, and
 * fences the old session at its next claim (a fresh, higher generation).
 */
import type { Database } from 'bun:sqlite';
import type { Workspace } from './project';
import { openJournal, type LeaseRow } from './schema';
import { conflictsIn } from './checks';
import { expandAliases, normalizeScope, type NormalizedScope } from './scopes';
import { activeLeases, ensureSession, ensureTask, reapExpired, sessionActor } from './sessions';
import { refreshLockfile } from './lockfile';
import { appendTransition } from './transitions';

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
	/** Per-worktree token ('' = main/shared) — path leases only conflict within one worktree. */
	worktree?: string;
	/** Forced takeover: delete the conflicting leases, audit who/why, grant anyway. */
	force?: boolean;
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
	rationale: string,
	worktree: string,
	generation: number
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
	db.query(
		`INSERT INTO leases (boundary_id, scope, scope_type, normalized, session_id, task_id,
			generation, heartbeat_ms, expires_ms, rationale, worktree)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
		rationale,
		worktree
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
	const worktree = input.worktree ?? '';
	const requests: NormalizedScope[] = expandAliases(input.scopes, input.workspace.aliases).map(
		(scope) => normalizeScope(scope, input.workspace.root)
	);
	if (requests.length === 0) throw new Error('scopes expand to nothing');
	const db = openJournal(input.workspace);
	try {
		db.exec('BEGIN IMMEDIATE');
		try {
			reapExpired(db, input.workspace.id, now);
			const blocking = conflictsIn(db, input.workspace.id, input.sessionId, requests, worktree, now);
			if (blocking.length > 0 && !input.force) {
				db.exec('ROLLBACK');
				return {
					ok: false,
					conflicts: blocking.map((lease) => ({
						scope: lease.scope,
						sessionId: lease.session_id,
						actor: sessionActor(db, lease.session_id),
						expiresMs: lease.expires_ms
					}))
				};
			}
			// Fencing token: the next generation is computed before any takeover
			// deletion, so a takeover always bumps past the leases it removes.
			let nextGeneration = (
				db.query('SELECT COALESCE(MAX(generation), 0) AS g FROM leases').get() as { g: number }
			).g + 1;
			if (blocking.length > 0) {
				// Forced takeover: delete the conflicting grants and fence the old session.
				for (const lease of blocking)
					db.query('DELETE FROM leases WHERE id = ?').run(lease.id);
				appendTransition(db, {
					workspace: input.workspace,
					operation: 'lease-takeover',
					summary: `forced takeover of ${blocking.length} lease(s)`,
					sessionId: input.sessionId,
					scopes: requests.map((request) => request.scope),
					extra: {
						from: blocking.map((lease) => sessionActor(db, lease.session_id)),
						fromSessions: blocking.map((lease) => lease.session_id),
						reason: input.rationale
					},
					now
				});
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
				grantLease(db, input.workspace, request, input.sessionId, taskId, now, ttlMs, input.rationale, worktree, nextGeneration);
				nextGeneration += 1;
			}
			appendTransition(db, {
				workspace: input.workspace,
				operation: 'lease-claim',
				summary: `claimed ${requests.length} scope(s)`,
				sessionId: input.sessionId,
				scopes: requests.map((request) => request.scope),
				extra: { task: taskId, ttlMs, worktree },
				now
			});
			db.exec('COMMIT');
			refreshLockfile(input.workspace, db, now);
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