/**
 * Versioned SQLite schema. `events` stays the audit trail (v1, unchanged shape);
 * v2 added the explicit state model (`sessions`, `tasks`, `leases`); v3 adds
 * subagent parentage + session close columns, per-worktree leases, and the two
 * support tables: short-retention `telemetry` and retry-proof `processed`.
 */
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Database } from 'bun:sqlite';
import type { Workspace } from './project';

export const SCHEMA_VERSION = 3;

export type SessionRow = {
	id: string;
	boundary_id: string;
	actor: string;
	started_at: number;
	last_heartbeat: number;
	status: string;
	meta: string;
	parent_id: string | null;
	closed_at: number | null;
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
	worktree: string;
};

const BASE_DDL = `
CREATE TABLE IF NOT EXISTS events (
	seq INTEGER PRIMARY KEY, at_ms INTEGER NOT NULL, kind TEXT NOT NULL, op_id TEXT NOT NULL,
	operation TEXT NOT NULL, actor TEXT NOT NULL, bead TEXT NOT NULL, scopes TEXT NOT NULL,
	summary TEXT NOT NULL, expires_ms INTEGER, outcome TEXT NOT NULL, detail TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
	id TEXT PRIMARY KEY, boundary_id TEXT NOT NULL, actor TEXT NOT NULL,
	started_at INTEGER NOT NULL, last_heartbeat INTEGER NOT NULL,
	status TEXT NOT NULL DEFAULT 'active', meta TEXT NOT NULL DEFAULT '{}',
	parent_id TEXT, closed_at INTEGER
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
	worktree TEXT NOT NULL DEFAULT '',
	UNIQUE(boundary_id, session_id, normalized)
);
CREATE TABLE IF NOT EXISTS telemetry (
	id INTEGER PRIMARY KEY, at_ms INTEGER NOT NULL, session_id TEXT NOT NULL,
	hook TEXT NOT NULL, name TEXT NOT NULL, payload TEXT NOT NULL, ttl_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS processed (
	key TEXT PRIMARY KEY, at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_leases_boundary ON leases(boundary_id);
CREATE INDEX IF NOT EXISTS idx_telemetry_at ON telemetry(at_ms);
`;

/** v2 -> v3: add the state columns the v2 tables were missing. */
const V3_ALTERS = [
	'ALTER TABLE sessions ADD COLUMN parent_id TEXT',
	'ALTER TABLE sessions ADD COLUMN closed_at INTEGER',
	'ALTER TABLE leases ADD COLUMN worktree TEXT NOT NULL DEFAULT \'\''
];

function hasColumn(db: Database, table: string, column: string): boolean {
	return (db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).some(
		(row) => row.name === column
	);
}

/** Idempotent migration to SCHEMA_VERSION. Never downgrades. */
export function migrate(db: Database): void {
	const version = (db.query('PRAGMA user_version').get() as { user_version: number }).user_version;
	if (version === SCHEMA_VERSION) return;
	if (version > SCHEMA_VERSION)
		throw new Error(
			`agent-log: database schema v${version} is newer than supported v${SCHEMA_VERSION}`
		);
	if (version === 2) {
		for (const alter of V3_ALTERS) {
			const [table, column] = alter.match(/ALTER TABLE (\w+) ADD COLUMN (\w+)/)!.slice(1);
			if (!hasColumn(db, table, column)) db.exec(alter);
		}
	}
	db.exec(BASE_DDL);
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
