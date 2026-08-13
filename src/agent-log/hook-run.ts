/**
 * `atlas agent-log hook` — the harness adapter core. One internal event shape
 * (hooks.ts), one dispatch per event (below), and mode-gated decisions:
 * off = silent, observe = check-only telemetry, warn = acquire + report,
 * enforce = acquire + block. Every failure path is silent: a broken journal
 * or payload must never break the harness.
 */
import { hashOf } from './project';
import { resolveWorkspace, type Workspace } from './project';
import { boundaryActor } from './actor';
import { idempotencyKey, type HookInput } from './hooks';
import { claimScopes } from './leases';
import { wouldConflict } from './checks';
import { closeSession, ensureSession, ensureTask, reapExpired, sessionActor } from './sessions';
import { openJournal } from './schema';
import { markProcessed, recordTelemetry, wasProcessed } from './telemetry';
import { appendTransition, checkpointEvent } from './transitions';
import { gatherStatus, renderStatus } from './status';
import { deriveToolScopes, worktreeToken } from './tools';
import { renewLeases } from './lifecycle';
import { refreshLockfile } from './lockfile';

export type HookDecision = {
	context?: string;
	block?: boolean;
	reason?: string;
};

const SNAPSHOT_CAP = 2000;
const TOOL_TTL_MS = 25 * 60_000;

function statusSnapshot(workspace: Workspace, sessionId: string, now: number): string {
	const rendered = renderStatus(gatherStatus(workspace, sessionId), now);
	return rendered.length > SNAPSHOT_CAP ? `${rendered.slice(0, SNAPSHOT_CAP)}…` : rendered;
}

const sessionFor = (workspace: Workspace, actor: string, explicit?: string): string =>
	explicit ?? hashOf(`${workspace.id}|${actor}`);

/** Prompt → task title: first non-empty line, truncated. The full prompt is never stored. */
function titleFromPrompt(prompt: string): string {
	const line = prompt.split('\n').map((part) => part.trim()).find(Boolean) ?? 'session';
	return line.slice(0, 80);
}

/** Auto handoff + session close for SessionEnd — the durable baton. */
function closeWithHandoff(
	workspace: Workspace,
	db: Parameters<typeof closeSession>[0],
	sessionId: string,
	reason: string | undefined,
	transcriptPath: string | undefined,
	now: number
): number {
	const task = db
		.query("SELECT title FROM tasks WHERE session_id = ? AND status = 'open' ORDER BY opened_at DESC LIMIT 1")
		.get(sessionId) as { title: string } | null;
	const leases = (
		db.query('SELECT COUNT(*) AS n FROM leases WHERE session_id = ? AND expires_ms > ?').get(sessionId, now) as {
			n: number;
		}
	).n;
	closeSession(db, sessionId, now);
	db.query(`INSERT INTO events
		(at_ms, kind, op_id, operation, actor, bead, scopes, summary, expires_ms, outcome, detail)
		VALUES (?, 'handoff', '', '', ?, '', '[]', ?, NULL, '', ?)`).run(
		now,
		sessionActor(db, sessionId),
		`session ended (${reason ?? 'unknown'})`,
		JSON.stringify({
			auto: true,
			session_id: sessionId,
			task: task?.title ?? '',
			leases,
			...(transcriptPath ? { transcript_path: transcriptPath } : {})
		})
	);
	return leases;
}

/** Dispatch one normalized hook event against the boundary journal. */
export function runHookEvent(input: HookInput, now = Date.now()): HookDecision {
	const cwd = input.cwd ?? process.cwd();
	const workspace = resolveWorkspace(cwd);
	if (!workspace || workspace.mode === 'off') return {};
	const db = openJournal(workspace);
	try {
		const key = idempotencyKey(input);
		if (wasProcessed(db, key)) return {};
		const actor = boundaryActor(workspace.root);
		const sessionId = sessionFor(workspace, actor, input.sessionId);
		let decision: HookDecision = {};
		switch (input.event) {
			case 'SessionStart': {
				reapExpired(db, workspace.id, now);
				ensureSession(db, workspace.id, sessionId, actor, now);
				recordTelemetry(db, sessionId, input.harness, 'SessionStart', {
					transcript: input.transcriptPath ?? null
				});
				decision = { context: statusSnapshot(workspace, sessionId, now) };
				break;
			}
			case 'UserPromptSubmit': {
				ensureSession(db, workspace.id, sessionId, actor, now);
				const title = titleFromPrompt(input.prompt ?? '');
				ensureTask(db, workspace.id, sessionId, undefined, title, now);
				recordTelemetry(db, sessionId, input.harness, 'UserPromptSubmit', {
					title,
					promptHash: hashOf(input.prompt ?? '')
				});
				break;
			}
			case 'SubagentStart': {
				const childId = sessionFor(workspace, actor, input.sessionId);
				ensureSession(db, workspace.id, childId, actor, now);
				recordTelemetry(db, childId, input.harness, 'SubagentStart', {
					subagentType: input.subagentType ?? null,
					parentToolCallId: input.parentToolCallId ?? null
				});
				break;
			}
			case 'SubagentStop': {
				closeSession(db, sessionId, now);
				recordTelemetry(db, sessionId, input.harness, 'SubagentStop', {});
				break;
			}
			case 'PreToolUse': {
				const derived = deriveToolScopes(
					input.toolName ?? '',
					input.toolInput ?? {},
					workspace.root
				);
				if (derived.scopes.length === 0) {
					recordTelemetry(db, sessionId, input.harness, 'PreToolUse', {
						tool: input.toolName ?? '',
						opaque: derived.opaque,
						note: derived.note[0] ?? ''
					});
					break;
				}
				const worktree = worktreeToken(cwd);
				if (workspace.mode === 'observe') {
					const conflicts = wouldConflict(workspace, sessionId, derived.scopes, worktree, now);
					recordTelemetry(db, sessionId, input.harness, 'PreToolUse', {
						tool: input.toolName ?? '',
						scopes: derived.scopes,
						worktree,
						wouldConflict: conflicts.length
					});
					break;
				}
				const result = claimScopes({
					workspace,
					sessionId,
					actor,
					scopes: derived.scopes,
					rationale: `pre-tool ${input.toolName ?? 'unknown'}`,
					ttlMs: TOOL_TTL_MS,
					worktree,
					now
				});
				recordTelemetry(db, sessionId, input.harness, 'PreToolUse', {
					tool: input.toolName ?? '',
					scopes: derived.scopes,
					worktree,
					denied: !result.ok
				});
				if (!result.ok) {
					const reason = `agent-log: would-be conflict — ${result.conflicts
						.map(
							(conflict) =>
								`${conflict.scope} held by ${conflict.actor} until ${new Date(conflict.expiresMs).toTimeString().slice(0, 8)}`
						)
						.join('; ')}`;
					if (workspace.mode === 'enforce') decision = { block: true, reason };
					else decision = { block: false, reason };
				}
				break;
			}
			case 'PostToolUse': {
				renewLeases(workspace, sessionId, TOOL_TTL_MS, now);
				recordTelemetry(db, sessionId, input.harness, 'PostToolUse', {
					tool: input.toolName ?? ''
				});
				break;
			}
			case 'PreCompact': {
				const owned = (
					db
						.query('SELECT COUNT(*) AS n FROM leases WHERE session_id = ? AND expires_ms > ?')
						.get(sessionId, now) as { n: number }
				).n;
				checkpointEvent(db, {
					workspace,
					sessionId,
					auto: true,
					extra: { leases: owned },
					now
				});
				recordTelemetry(db, sessionId, input.harness, 'PreCompact', {
					trigger: input.trigger ?? null
				});
				break;
			}
			case 'PostCompact': {
				recordTelemetry(db, sessionId, input.harness, 'PostCompact', {});
				decision = { context: statusSnapshot(workspace, sessionId, now) };
				break;
			}
			case 'Stop': {
				const owned = (
					db
						.query('SELECT COUNT(*) AS n FROM leases WHERE session_id = ? AND expires_ms > ?')
						.get(sessionId, now) as { n: number }
				).n;
				if (owned > 0) {
					appendTransition(db, {
						workspace,
						operation: 'checkpoint-required',
						summary: `session stopped while holding ${owned} lease(s)`,
						sessionId,
						extra: { leases: owned },
						now
					});
					console.warn(
						`agent-log: session still holds ${owned} lease(s) — run 'atlas agent-log checkpoint --done ... --next ...'`
					);
				}
				recordTelemetry(db, sessionId, input.harness, 'Stop', { leases: owned });
				break;
			}
			case 'SessionEnd': {
				const released = closeWithHandoff(
					workspace,
					db,
					sessionId,
					input.reason,
					input.transcriptPath,
					now
				);
				db.query('DELETE FROM leases WHERE session_id = ?').run(sessionId);
				refreshLockfile(workspace, db, now);
				recordTelemetry(db, sessionId, input.harness, 'SessionEnd', { leasesReleased: released });
				break;
			}
			default:
				recordTelemetry(db, sessionId, input.harness, input.event, {});
		}
		markProcessed(db, key, now);
		return decision;
	} finally {
		db.close();
	}
}