/**
 * `agent-log guard` — lease-aware wrapper for high-risk commands. Scopes come
 * from --scope flags or the Bash allowlist; the command runs only when the
 * session can hold them (enforce blocks, warn reports), and the outcome +
 * exit code land as a transition. Opaque commands run but are never blocked.
 */
import type { Workspace } from './project';
import { boundaryActor } from './actor';
import { claimScopes } from './leases';
import { releaseScopes } from './lifecycle';
import { openJournal } from './schema';
import { sessionIdFor } from './sessions';
import { appendTransition } from './transitions';
import { deriveBashScopes, worktreeToken } from './tools';

export type GuardOutcome = { block: boolean; reason?: string };

export function guardCommand(
	workspace: Workspace,
	command: string[],
	declaredScopes: string[],
	sessionId: string | undefined
): GuardOutcome {
	const actor = boundaryActor(workspace.root);
	const id = sessionIdFor(workspace, actor, sessionId);
	const shell = command.join(' ');
	const derived = deriveBashScopes(shell, workspace.root);
	const scopes = declaredScopes.length > 0 ? declaredScopes : derived.scopes;
	if (scopes.length === 0) {
		// Opaque or read-only: context, never a block.
		console.error(
			`agent-log: guard: '${shell.slice(0, 80)}' is outside the scope allowlist — running unguarded (${derived.note[0] ?? 'no scopes'})`
		);
		return { block: false };
	}
	const result = claimScopes({
		workspace,
		sessionId: id,
		actor,
		scopes,
		rationale: `guard: ${shell.slice(0, 120)}`,
		worktree: worktreeToken(workspace.root)
	});
	if (!result.ok) {
		const reason = `guard: conflict on ${result.conflicts
			.map((conflict) => `${conflict.scope} (${conflict.actor})`)
			.join(', ')}`;
		if (workspace.mode === 'enforce') return { block: true, reason };
		console.error(`agent-log: ${reason} — running anyway (${workspace.mode} mode)`);
		return { block: false };
	}
	const db = openJournal(workspace);
	try {
		appendTransition(db, {
			workspace,
			operation: 'guard-start',
			summary: `guard: ${shell.slice(0, 240)}`,
			sessionId: id,
			scopes,
			extra: { declared: declaredScopes.length > 0, opaque: derived.opaque }
		});
	} finally {
		db.close();
	}
	return { block: false };
}

/** Record the wrapped command's outcome and release the guard's leases. */
export function guardFinished(
	workspace: Workspace,
	sessionId: string | undefined,
	command: string[],
	declaredScopes: string[],
	exitCode: number
): void {
	const actor = boundaryActor(workspace.root);
	const id = sessionIdFor(workspace, actor, sessionId);
	const scopes = declaredScopes.length > 0 ? declaredScopes : deriveBashScopes(command.join(' '), workspace.root).scopes;
	const db = openJournal(workspace);
	try {
		appendTransition(db, {
			workspace,
			operation: 'guard-end',
			summary: `guard finished (${exitCode === 0 ? 'ok' : 'failed'})`,
			sessionId: id,
			scopes,
			extra: { command: command.join(' ').slice(0, 240), exit_code: exitCode }
		});
	} finally {
		db.close();
	}
	releaseScopes(workspace, id, scopes);
}