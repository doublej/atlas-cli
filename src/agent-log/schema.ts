/**
 * Versioned SQLite schema. `events` stays the audit trail (v1, unchanged shape);
 * v2 adds the explicit state model: `sessions`, `tasks`, and renewable `leases`.
 * Both live in the same journal file per boundary.
 */
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Database } from 'bun:sqlite';
import type { Workspace } from './project';

export const SCHEMA_VERSION = 2;

export type SessionRow = {
	id: string;
	boundary_id: string;
	actor: string;
	started_at: number;
	last_heartbeat: number;
	status: string;
	meta: string;
};

export type TaskRow = {
	id: string;
	session_id: string;
	boundary_id: string;
	title: string;
	status: string;
	opened_at: number;
	closed_at: number | null;
};

export type LeaseRow = {
	id: number;
	boundary_id: string;
	scope: string;
	scope_type: string;
	normalized: string;
	session_id: string;
	task_id: string;
	generation: number;
	heartbeat_ms: number;
	expires_ms: number;
	rationale: string;
};

const DDL = `
CREATE TABLE IF NOT EXISTS events (
	seq INTEGER PRIMARY KEY, at_ms INTEGER NOT NULL, kind TEXT NOT NULL, op_id TEXT NOT NULL,
	operation TEXT NOT NULL, actor TEXT NOT NULL, bead TEXT NOT NULL, scopes TEXT NOT NULL,
	summary TEXT NOT NULL, expires_ms INTEGER, outcome TEXT NOT NULL, detail TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
	id TEXT PRIMARY KEY, boundary_id TEXT NOT NULL, actor TEXT NOT NULL,
	started_at INTEGER NOT NULL, last_heartbeat INTEGER NOT NULL,
	status TEXT NOT NULL DEFAULT 'active', meta TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS tasks (
	id TEXT PRIMARY KEY, session_id TEXT NOT NULL, boundary_id TEXT NOT NULL,
	title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open',
	opened_at INTEGER NOT NULL, closed_at INTEGER
);
CREATE TABLE IF NOT EXISTS leases (
	id INTEGER PRIMARY KEY, boundary_id TEXT NOT NULL, scope TEXT NOT NULL,
	scope_type TEXT NOT NULL, normalized TEXT NOT NULL, session_id TEXT NOT NULL,
	task_id TEXT NOT NULL, generation INTEGER NOT NULL, heartbeat_ms INTEGER NOT NULL,
	expires_ms INTEGER NOT NULL, rationale TEXT NOT NULL,
	UNIQUE(boundary_id, session_id, normalized)
);
CREATE INDEX IF NOT EXISTS idx_leases_boundary ON leases(boundary_id);
`;

/** Idempotent migration to SCHEMA_VERSION. Never downgrades. */
export function migrate(db: Database): void {
	const version = (db.query('PRAGMA user_version').get() as { user_version: number }).user_version;
	if (version === SCHEMA_VERSION) return;
	if (version > SCHEMA_VERSION)
		throw new Error(
			`agent-log: database schema v${version} is newer than supported v${SCHEMA_VERSION}`
		);
	db.exec(DDL);
	db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}

/** Where the boundary's journal lives: env override (tests/sandboxes), else beside the boundary. */
export function journalPath(workspace: Workspace): string {
	const override = process.env.ATLAS_AGENT_LOG_PATH;
	if (override) return override;
	return join(workspace.stateDir, 'agent-log.sqlite');
}

/** Open (creating + migrating) the boundary's journal. WAL + busy timeout for concurrency. */
export function openJournal(workspace: Workspace): Database {
	const path = journalPath(workspace);
	mkdirSync(dirname(path), { recursive: true });
	const db = new Database(path, { create: true });
	db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL');
	migrate(db);
	return db;
}