/**
 * `agent-log gc` — retention + safe cleanup, never required on the hot path.
 * Telemetry (14d) and idempotency markers (30d) age out; leases expired for
 * over a week and sessions closed for over 90 days are dropped; stale active
 * sessions (no leases, no open tasks, silent for 24h) are closed.
 */
import type { Workspace } from './project';
import { openJournal } from './schema';
import { reapRetention } from './telemetry';

const STALE_SESSION_MS = 24 * 3_600_000;

export function runGc(workspace: Workspace, dryRun = false): string[] {
	const db = openJournal(workspace);
	try {
		const lines: string[] = [];
		const now = Date.now();
		if (!dryRun) {
			const removed = reapRetention(db, now);
			lines.push(`  telemetry:  ${removed.telemetry} row(s) older than 14d removed`);
			lines.push(`  processed:  ${removed.processed} idempotency marker(s) older than 30d removed`);
			lines.push(`  leases:     ${removed.leases} lease(s) expired over a week ago removed`);
			lines.push(`  sessions:   ${removed.sessions} session(s) closed over 90d ago removed`);
		} else {
			const counts = {
				telemetry: (db.query('SELECT COUNT(*) AS n FROM telemetry WHERE at_ms + ttl_ms < ?').get(now) as { n: number }).n,
				processed: (db.query('SELECT COUNT(*) AS n FROM processed WHERE at_ms < ?').get(now - 30 * 24 * 3_600_000) as { n: number }).n,
				leases: (db.query('SELECT COUNT(*) AS n FROM leases WHERE expires_ms < ?').get(now - 7 * 24 * 3_600_000) as { n: number }).n,
				sessions: (db.query("SELECT COUNT(*) AS n FROM sessions WHERE status = 'closed' AND closed_at < ?").get(now - 90 * 24 * 3_600_000) as { n: number }).n
			};
			lines.push('  dry-run (nothing removed):');
			lines.push(`    telemetry:  ${counts.telemetry} · processed: ${counts.processed}`);
			lines.push(`    leases:     ${counts.leases} · sessions: ${counts.sessions}`);
		}
		const stale = db
			.query(`SELECT s.id, s.actor FROM sessions s
				WHERE s.status = 'active' AND s.started_at < ?
				AND NOT EXISTS (SELECT 1 FROM leases l WHERE l.session_id = s.id AND l.expires_ms > ?)
				AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.session_id = s.id AND t.status = 'open')`)
			.all(now - STALE_SESSION_MS, now) as { id: string; actor: string }[];
		if (dryRun) {
			lines.push(`  stale:      ${stale.length} would be closed: ${stale.map((s) => s.actor).join(', ') || 'none'}`);
		} else {
			for (const session of stale)
				db.query(`UPDATE sessions SET status = 'closed', closed_at = ? WHERE id = ?`).run(now, session.id);
			lines.push(`  stale:      ${stale.length} inactive session(s) closed`);
		}
		return lines;
	} finally {
		db.close();
	}
}