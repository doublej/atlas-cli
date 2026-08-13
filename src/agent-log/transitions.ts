/**
 * State-transition events (v2 cross-cutting: "generate events from state
 * transitions"). Claims, releases, sessions, checkpoints, and takeovers append
 * to the same `events` audit table as intents/findings/ends — `recent` shows
 * them on the --since window, and `status` stays the state view.
 */
import type { Database } from 'bun:sqlite';
import type { Workspace } from './project';
import { sessionActor } from './sessions';

export type TransitionInput = {
	workspace: Workspace;
	operation: string;
	summary: string;
	sessionId: string;
	scopes?: string[];
	extra?: Record<string, unknown>;
	now?: number;
};

export function appendTransition(db: Database, input: TransitionInput): void {
	const now = input.now ?? Date.now();
	db.query(`INSERT INTO events
		(at_ms, kind, op_id, operation, actor, bead, scopes, summary, expires_ms, outcome, detail)
		VALUES (?, 'transition', '', ?, ?, '', ?, ?, NULL, '', ?)`).run(
		now,
		input.operation,
		sessionActor(db, input.sessionId) ?? input.workspace.id,
		JSON.stringify(input.scopes ?? []),
		input.summary.slice(0, 240),
		JSON.stringify(input.extra ?? {})
	);
}

/** Structured checkpoint state (`checkpoint --done --next --blocked` and auto compact checkpoints). */
export function checkpointEvent(
	db: Database,
	input: {
		workspace: Workspace;
		sessionId: string;
		done?: string;
		next?: string;
		blocked?: string;
		auto?: boolean;
		extra?: Record<string, unknown>;
		now?: number;
	}
): void {
	const { done, next, blocked, auto, extra, workspace, sessionId, now } = input;
	const parts = [done && `done: ${done}`, next && `next: ${next}`, blocked && `blocked: ${blocked}`]
		.filter(Boolean)
		.join(' | ');
	appendTransition(db, {
		workspace,
		operation: 'checkpoint',
		summary: auto ? `checkpoint (auto, ${extra?.leases ?? 0} lease(s))` : (parts || 'checkpoint'),
		sessionId,
		extra: { done, next, blocked, auto: Boolean(auto), ...extra },
		now
	});
}