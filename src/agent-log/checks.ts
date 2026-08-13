/**
 * Read-only conflict checks (observe mode, pre-claim probes): the same overlap
 * rules as a claim transaction, but nothing is written or reaped.
 */
import type { Database } from 'bun:sqlite';
import type { Workspace } from './project';
import { openJournal, type LeaseRow } from './schema';
import { conflictsWith, expandAliases, normalizeScope, type NormalizedScope } from './scopes';
import { activeLeases, sessionActor } from './sessions';

export type ConflictInfo = { scope: string; sessionId: string; actor: string; expiresMs: number };

/** Path leases in separate worktrees do not conflict; everything else stays shared.
 *  '' and 'main' are the same worktree (CLI claims vs hook-derived tokens). */
export function sameWorktreeDomain(held: LeaseRow, request: NormalizedScope, worktree: string): boolean {
	if (held.scope_type !== 'path' || request.type !== 'path') return true;
	return (held.worktree || 'main') === (worktree || 'main');
}

/** Would-be conflicts of `scopes` against other sessions' live leases. */
export function wouldConflict(
	workspace: Workspace,
	sessionId: string,
	scopes: string[],
	worktree = '',
	now = Date.now()
): ConflictInfo[] {
	const requests = expandAliases(scopes, workspace.aliases).map((scope) =>
		normalizeScope(scope, workspace.root)
	);
	const db = openJournal(workspace);
	try {
		const held = activeLeases(db, workspace.id, now).filter(
			(lease) => lease.session_id !== sessionId
		);
		return held
			.filter((lease) =>
				requests.some(
					(request) =>
						sameWorktreeDomain(lease, request, worktree) &&
						conflictsWith(
							{ type: lease.scope_type, normalized: lease.normalized },
							request
						)
				)
			)
			.map((lease) => ({
				scope: lease.scope,
				sessionId: lease.session_id,
				actor: sessionActor(db, lease.session_id),
				expiresMs: lease.expires_ms
			}));
	} finally {
		db.close();
	}
}

/** Whether a db connection has a would-be conflict — the in-transaction twin. */
export function conflictsIn(
	db: Database,
	workspaceId: string,
	sessionId: string,
	requests: NormalizedScope[],
	worktree: string,
	now: number
): LeaseRow[] {
	const held = activeLeases(db, workspaceId, now).filter((lease) => lease.session_id !== sessionId);
	return held.filter((lease) =>
		requests.some(
			(request) =>
				sameWorktreeDomain(lease, request, worktree) &&
				conflictsWith(
					{ type: lease.scope_type, normalized: lease.normalized },
					request
				)
		)
	);
}