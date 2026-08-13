/**
 * Support tables: low-level hook telemetry (short retention — `gc` reaps it)
 * and idempotency markers so duplicated hook delivery creates one transition.
 * Never on the hot path of `status`.
 */
import type { Database } from 'bun:sqlite';

export const TELEMETRY_TTL_MS = 14 * 24 * 3_600_000;
export const PROCESSED_TTL_MS = 30 * 24 * 3_600_000;
const PAYLOAD_CAP = 1500;

export function recordTelemetry(
	db: Database,
	sessionId: string,
	hook: string,
	name: string,
	payload: unknown,
	ttlMs = TELEMETRY_TTL_MS,
	now = Date.now()
): void {
	const json = JSON.stringify(payload);
	db.query(`INSERT INTO telemetry (at_ms, session_id, hook, name, payload, ttl_ms)
		VALUES (?, ?, ?, ?, ?, ?)`).run(
		now,
		sessionId.slice(0, 64),
		hook,
		name.slice(0, 64),
		json.length > PAYLOAD_CAP ? json.slice(0, PAYLOAD_CAP) : json,
		ttlMs
	);
}

/** Hooks can retry — the same (harness, session, tool-use, phase) runs once. */
export function wasProcessed(db: Database, key: string): boolean {
	return Boolean(db.query('SELECT 1 FROM processed WHERE key = ?').get(key));
}

export function markProcessed(db: Database, key: string, now = Date.now()): void {
	db.query('INSERT OR IGNORE INTO processed (key, at_ms) VALUES (?, ?)').run(key, now);
}

/** Retention sweep for `gc`. Returns the deleted-row count per table. */
export function reapRetention(
	db: Database,
	now = Date.now()
): { telemetry: number; processed: number; leases: number; sessions: number } {
	return {
		telemetry: Number(
			db.query('DELETE FROM telemetry WHERE at_ms + ttl_ms < ?').run(now).changes
		),
		processed: Number(
			db.query('DELETE FROM processed WHERE at_ms < ?').run(now - PROCESSED_TTL_MS).changes
		),
		leases: Number(
			db
				.query('DELETE FROM leases WHERE expires_ms < ?')
				.run(now - 7 * 24 * 3_600_000).changes
		),
		sessions: Number(
			db
				.query("DELETE FROM sessions WHERE status = 'closed' AND closed_at < ?")
				.run(now - 90 * 24 * 3_600_000).changes
		)
	};
}