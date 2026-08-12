/**
 * `agent-log doctor` — diagnostics for the state foundation: schema version,
 * stale sessions, expired (crash) leases, unresolved aliases, missing members,
 * and clock skew. Report-only; the only write is the idempotent migration.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import type { Workspace } from './project';
import { journalPath, openJournal, SCHEMA_VERSION } from './schema';
import { expandAliases, normalizeScope, ScopeError } from './scopes';

const STALE_SESSION_MS = 24 * 3_600_000;
const CLOCK_SKEW_MS = 5 * 60_000;
const MODES: readonly string[] = ['off', 'observe', 'warn', 'enforce'];

export type DoctorReport = { ok: boolean; lines: string[] };

export function runDoctor(workspace: Workspace): DoctorReport {
	const lines: string[] = [];
	const issues: string[] = [];
	const path = journalPath(workspace);

	// Schema check without migrating: a v0/v1 journal is fine — it migrates on first claim.
	let schemaVersion: number | null = null;
	if (existsSync(path)) {
		const probe = new Database(path, { readonly: true });
		schemaVersion = (probe.query('PRAGMA user_version').get() as { user_version: number }).user_version;
		probe.close();
	}
	if (schemaVersion === null) {
		lines.push(`  journal:   not created yet (created on first claim)`);
	} else if (schemaVersion === SCHEMA_VERSION) {
		lines.push(`  schema:    v${schemaVersion} (ok)`);
	} else {
		issues.push(`schema v${schemaVersion} — migrates to v${SCHEMA_VERSION} on first claim`);
		lines.push(`  schema:    v${schemaVersion} (will migrate to v${SCHEMA_VERSION})`);
	}

	if (!(MODES as string[]).includes(workspace.mode))
		issues.push(`unknown coordination mode '${workspace.mode}'`);

	lines.push(
		`  project:   ${workspace.root} · ${workspace.mode} · boundary ${workspace.boundary}`
	);

	const aliases = Object.entries(workspace.aliases);
	if (aliases.length === 0) {
		lines.push('  aliases:   none defined');
	} else {
		const unresolved: string[] = [];
		for (const [name, expansion] of aliases) {
			for (const scope of expandAliases([name], workspace.aliases)) {
				try {
					normalizeScope(scope, workspace.root);
				} catch (error) {
					if (error instanceof ScopeError) unresolved.push(`${name} → ${scope}`);
					else throw error;
				}
			}
		}
		lines.push(
			unresolved.length === 0
				? `  aliases:   ${aliases.length} defined, all resolve (ok)`
				: `  aliases:   ${unresolved.join(', ')}`
		);
		if (unresolved.length) issues.push(`${unresolved.length} unresolved alias(es)`);
	}

	const missingMembers = workspace.members.filter((member) => !existsSync(join(workspace.root, member)));
	lines.push(
		missingMembers.length === 0
			? `  members:   ${workspace.members.length} configured (ok)`
			: `  members:   missing: ${missingMembers.join(', ')}`
	);
	if (missingMembers.length) issues.push(`${missingMembers.length} missing member(s)`);

	const db = openJournal(workspace);
	try {
		const now = Date.now();
		const sessions = db.query(`SELECT * FROM sessions WHERE status = 'active'`).all() as {
			id: string;
			actor: string;
			started_at: number;
		}[];
		const leases = db.query('SELECT * FROM leases').all() as {
			session_id: string;
			heartbeat_ms: number;
			expires_ms: number;
		}[];
		const tasks = db.query(`SELECT session_id FROM tasks WHERE status = 'open'`).all() as {
			session_id: string;
		}[];
		const activeSessions = new Set(leases.filter((lease) => lease.expires_ms > now).map((l) => l.session_id));
		const taskSessions = new Set(tasks.map((task) => task.session_id));
		const stale = sessions.filter(
			(session) =>
				session.started_at < now - STALE_SESSION_MS &&
				!activeSessions.has(session.id) &&
				!taskSessions.has(session.id)
		);
		const expired = leases.filter((lease) => lease.expires_ms <= now);
		const future = leases.filter((lease) => lease.heartbeat_ms > now + CLOCK_SKEW_MS);
		lines.push(`  sessions:  ${sessions.length} active · ${stale.length} stale`);
		lines.push(`  leases:    ${leases.length - expired.length} active · ${expired.length} expired`);
		lines.push(`  tasks:     ${taskSessions.size} with open tasks`);
		if (stale.length) {
			issues.push(`${stale.length} stale session(s): ${stale.map((s) => s.actor).join(', ')}`);
		}
		if (expired.length) {
			issues.push(`${expired.length} expired lease(s) — crashed sessions, reaped on next claim`);
		}
		if (future.length) {
			issues.push(`${future.length} lease heartbeat(s) in the future — clock skew?`);
			lines.push(`  clock:     ${future.length} heartbeat(s) > ${CLOCK_SKEW_MS / 60_000}m in the future`);
		} else {
			lines.push('  clock:     no skew detected');
		}
	} finally {
		db.close();
	}

	if (issues.length) {
		lines.push('  issues:');
		for (const issue of issues) lines.push(`    - ${issue}`);
	}
	return { ok: issues.length === 0, lines };
}