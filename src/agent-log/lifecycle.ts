/**
 * Lease lifecycle outside the claim transaction: explicit release (all or by
 * scope) and renewal of a session's live leases (heartbeat + expiry). Both are
 * single statements — atomicity is guaranteed without an explicit transaction.
 * Releases emit a transition event and refresh the lockfile.
 */
import type { Workspace } from './project';
import { openJournal } from './schema';
import { normalizeScope } from './scopes';
import { DEFAULT_TTL_MS } from './leases';
import { refreshLockfile } from './lockfile';
import { appendTransition } from './transitions';

/** Release the session's leases — all of them, or only the ones matching the given scopes. */
export function releaseScopes(workspace: Workspace, sessionId: string, scopes?: string[]): number {
	const db = openJournal(workspace);
	try {
		const normalized = scopes?.map((scope) => normalizeScope(scope, workspace.root).normalized);
		let released: number;
		if (!normalized || normalized.length === 0) {
			released = Number(
				db
					.query('DELETE FROM leases WHERE boundary_id = ? AND session_id = ?')
					.run(workspace.id, sessionId).changes
			);
		} else {
			const placeholders = normalized.map(() => '?').join(', ');
			released = Number(
				db
					.query(
						`DELETE FROM leases WHERE boundary_id = ? AND session_id = ?
							AND normalized IN (${placeholders})`
					)
					.run(workspace.id, sessionId, ...normalized).changes
			);
		}
		if (released > 0) {
			appendTransition(db, {
				workspace,
				operation: 'lease-release',
				summary: `released ${released} lease(s)`,
				sessionId,
				scopes: scopes,
				extra: { released }
			});
			refreshLockfile(workspace, db);
		}
		return released;
	} finally {
		db.close();
	}
}

/** Renew every live lease of the session (heartbeat + expiry). Expired ones are left to reaping. */
export function renewLeases(
	workspace: Workspace,
	sessionId: string,
	ttlMs = DEFAULT_TTL_MS,
	now = Date.now()
): number {
	const db = openJournal(workspace);
	try {
		const renewed = Number(
			db
				.query(
					'UPDATE leases SET heartbeat_ms = ?, expires_ms = ? WHERE boundary_id = ? AND session_id = ? AND expires_ms > ?'
				)
				.run(now, now + ttlMs, workspace.id, sessionId, now).changes
		);
		if (renewed > 0) refreshLockfile(workspace, db, now);
		return renewed;
	} finally {
		db.close();
	}
}