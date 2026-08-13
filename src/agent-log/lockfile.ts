/**
 * Read-only JSON snapshot of the leases state, materialized for external tools
 * that have no SQLite. Never a second source of truth and never written to by
 * consumers: every state change refreshes it atomically (tmp + rename).
 */
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Database } from 'bun:sqlite';
import type { Workspace } from './project';
import { SCHEMA_VERSION, type SessionRow, type TaskRow } from './schema';

export function refreshLockfile(workspace: Workspace, db: Database, now = Date.now()): void {
	try {
		const snapshot = {
			contract: 'agent-log-v2',
			schemaVersion: SCHEMA_VERSION,
			boundaryId: workspace.id,
			boundaryKind: workspace.boundary,
			mode: workspace.mode,
			updatedAt: new Date(now).toISOString(),
			sessions: (db
				.query("SELECT id, actor, parent_id, started_at, status FROM sessions WHERE status = 'active'")
				.all() as SessionRow[]).map((row) => ({
				id: row.id,
				actor: row.actor,
				parentId: row.parent_id,
				startedAt: row.started_at
			})),
			leases: (db
				.query('SELECT * FROM leases WHERE expires_ms > ?')
				.all(now) as {
				scope: string;
				scope_type: string;
				session_id: string;
				task_id: string;
				generation: number;
				expires_ms: number;
				worktree: string;
			}[]).map((row) => ({
				scope: row.scope,
				type: row.scope_type,
				sessionId: row.session_id,
				taskId: row.task_id,
				generation: row.generation,
				expiresAt: row.expires_ms,
				worktree: row.worktree
			})),
			tasks: (db
				.query("SELECT id, session_id, title FROM tasks WHERE status = 'open'")
				.all() as TaskRow[]).map((row) => ({ id: row.id, sessionId: row.session_id, title: row.title }))
		};
		const path = join(workspace.stateDir, 'agent-log.lock.json');
		const tmp = `${path}.tmp`;
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(tmp, JSON.stringify(snapshot));
		renameSync(tmp, path);
	} catch {
		// best-effort sentinel — a failed snapshot never breaks the hot path
	}
}