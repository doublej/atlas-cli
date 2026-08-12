/**
 * Lease lifecycle outside the claim transaction: explicit release (all or by
 * scope) and renewal of a session's live leases (heartbeat + expiry). Both are
 * single statements — atomicity is guaranteed without an explicit transaction.
 */
import type { Workspace } from './project';
import { openJournal } from './schema';
import { normalizeScope } from './scopes';
import { DEFAULT_TTL_MS } from './leases';

/** Release the session's leases — all of them, or only the ones matching the given scopes. */
export function releaseScopes(workspace: Workspace, sessionId: string, scopes?: string[]): number {
	const db = openJournal(workspace);
	try {
		const normalized = scopes?.map((scope) => normalizeScope(scope, workspace.root).normalized);
		if (!normalized || normalized.length === 0)
			return Number(
				db
					.query('DELETE FROM leases WHERE boundary_id = ? AND session_id = ?')
					.run(workspace.id, sessionId).changes
			);
		const placeholders = normalized.map(() => '?').join(', ');
		return Number(
			db
				.query(
					`DELETE FROM leases WHERE boundary_id = ? AND session_id = ?
						AND normalized IN (${placeholders})`
				)
				.run(workspace.id, sessionId, ...normalized).changes
		);
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
		return Number(
			db
				.query(
					'UPDATE leases SET heartbeat_ms = ?, expires_ms = ? WHERE boundary_id = ? AND session_id = ? AND expires_ms > ?'
				)
				.run(now, now + ttlMs, workspace.id, sessionId, now).changes
		);
	} finally {
		db.close();
	}
}