/** SQLite event store — one journal per repo, in the git common dir (worktree-shared). */
import { Database } from 'bun:sqlite';
import { resolve } from 'node:path';
import { mirrorEvent } from './mirror';

export type EventKind = 'intent' | 'finding' | 'end' | 'handoff';
export type EventRow = {
	at_ms: number;
	kind: EventKind;
	op_id: string;
	operation: string;
	actor: string;
	bead: string;
	scopes: string;
	summary: string;
	expires_ms: number | null;
	outcome: string;
	detail: string;
};

type NewEvent = Omit<EventRow, 'at_ms'> & { at_ms?: number };

function git(args: string[]): string {
	const result = Bun.spawnSync(['git', ...args], { stderr: 'ignore' });
	return result.exitCode === 0 ? result.stdout.toString().trim() : '';
}

function databasePath(): string {
	if (process.env.ATLAS_AGENT_LOG_PATH) return process.env.ATLAS_AGENT_LOG_PATH;
	const commonDir = git(['rev-parse', '--path-format=absolute', '--git-common-dir']);
	if (!commonDir) throw new Error('agent-log: run inside a git repository');
	return resolve(commonDir, 'agent-log.sqlite');
}

function openDatabase(): Database {
	const db = new Database(databasePath(), { create: true });
	db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL');
	db.exec(`CREATE TABLE IF NOT EXISTS events (
		seq INTEGER PRIMARY KEY, at_ms INTEGER NOT NULL, kind TEXT NOT NULL, op_id TEXT NOT NULL,
		operation TEXT NOT NULL, actor TEXT NOT NULL, bead TEXT NOT NULL, scopes TEXT NOT NULL,
		summary TEXT NOT NULL, expires_ms INTEGER, outcome TEXT NOT NULL, detail TEXT NOT NULL
	)`);
	return db;
}

/** Best-effort db creation for `agent-log init`; the store also creates lazily on first write. */
export function warmDatabase(): void {
	openDatabase().close();
}

export function contextDetail(extra: Record<string, unknown> = {}): string {
	return JSON.stringify({
		cwd: process.cwd(),
		head: git(['rev-parse', '--short=12', 'HEAD']),
		dirty: git(['status', '--porcelain']).length > 0,
		...extra
	});
}

export function insertEvent(event: NewEvent): void {
	const row = { at_ms: Date.now(), ...event };
	const db = openDatabase();
	db.query(`INSERT INTO events
		(at_ms, kind, op_id, operation, actor, bead, scopes, summary, expires_ms, outcome, detail)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
		row.at_ms,
		row.kind,
		row.op_id,
		row.operation,
		row.actor,
		row.bead,
		row.scopes,
		row.summary,
		row.expires_ms,
		row.outcome,
		row.detail
	);
	db.close();
	mirrorEvent(row);
}

export function findIntent(opId: string): EventRow | null {
	const db = openDatabase();
	const row = db
		.query('SELECT * FROM events WHERE kind = ? AND op_id = ? ORDER BY seq DESC LIMIT 1')
		.get('intent', opId) as EventRow | null;
	db.close();
	return row;
}

export function loadEvents(): EventRow[] {
	const db = openDatabase();
	const rows = db.query('SELECT * FROM events ORDER BY seq').all() as EventRow[];
	db.close();
	return rows;
}
