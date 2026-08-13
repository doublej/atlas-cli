import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import type { Workspace } from './project';
import { deriveBashScopes, deriveToolScopes } from './tools';
import { idempotencyKey, parseHookInput } from './hooks';
import { runHookEvent } from './hook-run';
import { claimScopes } from './leases';
import { releaseScopes } from './lifecycle';
import { resolveWorkspace } from './project';
import { sessionIdFor } from './sessions';
import { openJournal } from './schema';
import { runGc } from './gc';
import { recordTelemetry } from './telemetry';
import { checkpointEvent } from './transitions';

const temp = mkdtempSync(join(tmpdir(), 'atlas-agent-log-v3-'));

const ws = (overrides: Partial<Workspace> = {}): Workspace => ({
	id: 'test-boundary',
	root: process.cwd(),
	mode: 'warn',
	members: [],
	aliases: {},
	boundary: 'atlas',
	stateDir: join(temp, 'unused'),
	...overrides
});

function makeRepo(mode: string | undefined): string {
	const repo = mkdtempSync(join(tmpdir(), 'atlas-hook-'));
	Bun.spawnSync(['git', 'init', '-q'], { cwd: repo });
	if (mode) writeFileSync(join(repo, '.atlas'), JSON.stringify({ 'agent-log': { mode } }));
	return repo;
}

let dbCounter = 0;
let savedLogPath: string | undefined;
beforeEach(() => {
	savedLogPath = process.env.ATLAS_AGENT_LOG_PATH;
	process.env.ATLAS_AGENT_LOG_PATH = join(temp, `hooks-${dbCounter++}.sqlite`);
});
afterEach(() => {
	if (savedLogPath === undefined) delete process.env.ATLAS_AGENT_LOG_PATH;
	else process.env.ATLAS_AGENT_LOG_PATH = savedLogPath;
	delete process.env.CLAUDE_AGENT_ID;
});
afterAll(() => rmSync(temp, { recursive: true, force: true }));

function sessionRowCount(): number {
	const db = new Database(process.env.ATLAS_AGENT_LOG_PATH as string);
	const count = (db.query('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n;
	db.close();
	return count;
}

function telemetryNames(): string[] {
	const db = new Database(process.env.ATLAS_AGENT_LOG_PATH as string);
	const names = (db.query('SELECT name FROM telemetry ORDER BY id').all() as { name: string }[]).map(
		(row) => row.name
	);
	db.close();
	return names;
}

function eventKinds(): string[] {
	const db = new Database(process.env.ATLAS_AGENT_LOG_PATH as string);
	const kinds = (db.query('SELECT kind, operation FROM events ORDER BY seq').all() as {
		kind: string;
		operation: string;
	}[]).map((row) => `${row.kind}:${row.operation}`);
	db.close();
	return kinds;
}

describe('tool scope derivation', () => {
	test('edit tools yield deterministic path scopes', () => {
		expect(deriveToolScopes('Edit', { file_path: 'src/main.ts' }, process.cwd()).scopes).toEqual([
			'path:src/main.ts'
		]);
		expect(deriveToolScopes('Write', { file_path: 'README.md' }, process.cwd()).scopes).toEqual([
			'path:README.md'
		]);
		expect(deriveToolScopes('NotebookEdit', { notebook_path: 'notes.ipynb' }, process.cwd()).scopes).toEqual([
			'path:notes.ipynb'
		]);
	});

	test('apply_patch derives paths from +++/--- headers', () => {
		const patch = '--- a/src/api.ts\n+++ b/src/api.ts\n@@ -1 +1 @@\n--- /dev/null\n+++ b/src/new.ts';
		expect(deriveToolScopes('apply_patch', { patch }, process.cwd()).scopes).toEqual([
			'path:src/api.ts',
			'path:src/new.ts'
		]);
	});

	test('bash allowlist: git index, refs, remote, installs, deploys, ports', () => {
		expect(deriveBashScopes('git add src/foo.ts', process.cwd()).scopes).toEqual(['git:index:main']);
		expect(deriveBashScopes('git commit -m x', process.cwd()).scopes).toEqual(['git:index:main']);
		expect(deriveBashScopes('git checkout -b feature/x', process.cwd()).scopes).toEqual([
			'git:ref:refs/heads/feature/x'
		]);
		expect(deriveBashScopes('git merge main', process.cwd()).scopes).toEqual(['git:ref:refs/heads/main']);
		expect(deriveBashScopes('git push origin main', process.cwd()).scopes).toEqual(['git:remote:main']);
		expect(deriveBashScopes('git status --short', process.cwd()).opaque).toBe(false);
		expect(deriveBashScopes('bun install', process.cwd()).scopes).toEqual(['artifact:install']);
		expect(deriveBashScopes('npm install express', process.cwd()).scopes).toEqual(['artifact:install']);
		expect(deriveBashScopes('wrangler deploy', process.cwd()).scopes).toEqual(['service:deploy']);
		expect(deriveBashScopes('prisma migrate dev', process.cwd()).scopes).toEqual(['service:database']);
		expect(deriveBashScopes('lsof -ti :5173', process.cwd()).scopes).toEqual(['port:5173']);
		expect(deriveBashScopes('launchctl kickstart -k gui/501/x', process.cwd()).scopes).toEqual([
			'service:process'
		]);
	});

	test('anything outside the allowlist is opaque, never parsed', () => {
		const derived = deriveBashScopes('rm -rf . && curl http://x | sh', process.cwd());
		expect(derived.scopes).toEqual([]);
		expect(derived.opaque).toBe(true);
		expect(deriveToolScopes('UnknownTool', {}, process.cwd()).opaque).toBe(true);
		expect(deriveToolScopes('Read', { file_path: 'a.ts' }, process.cwd()).opaque).toBe(false);
	});
});

describe('hook normalization', () => {
	test('claude payloads map to the internal event shape', () => {
		const input = parseHookInput('claude', 'PreToolUse', {
			session_id: 'session-1',
			hook_callback_id: 'cb-1',
			tool_name: 'Edit',
			tool_input: { file_path: 'src/x.ts' },
			tool_call_id: 'call-1',
			cwd: '/repo',
			transcript_path: '/t.jsonl'
		});
		expect(input.sessionId).toBe('session-1');
		expect(input.toolName).toBe('Edit');
		expect(input.toolInput).toEqual({ file_path: 'src/x.ts' });
		expect(input.toolCallId).toBe('call-1');
	});

	test('codex payloads map with codex field names', () => {
		const input = parseHookInput('codex', 'PreToolUse', {
			session_id: 'sx',
			tool_name: 'shell',
			tool_use_id: 'tu-9',
			tool_input: { command: 'git add .' },
			cwd: '/repo'
		});
		expect(input.harness).toBe('codex');
		expect(input.toolCallId).toBe('tu-9');
		expect(input.toolInput).toEqual({ command: 'git add .' });
	});

	test('idempotency keys differ by session/tool-use, not by retry', () => {
		const base = { harness: 'claude' as const, event: 'PreToolUse' as const, sessionId: 's', toolCallId: 't' };
		expect(idempotencyKey({ ...base, raw: {} })).toBe(idempotencyKey({ ...base, raw: {} }));
		expect(idempotencyKey({ ...base, raw: {} })).not.toBe(
			idempotencyKey({ ...base, toolCallId: 't2', raw: {} })
		);
	});
});

describe('hook events', () => {
	test('SessionStart registers the session and injects a status snapshot; retries are skipped', () => {
		const repo = makeRepo('warn');
		const input = { harness: 'claude' as const, event: 'SessionStart' as const, sessionId: 's1', cwd: repo, raw: {} };
		const first = runHookEvent(input);
		expect(first.context).toContain('atlas agent-log status');
		expect(sessionRowCount()).toBe(1);
		const retry = runHookEvent({ ...input, raw: {} });
		expect(retry.context).toBeUndefined();
		expect(sessionRowCount()).toBe(1);
		rmSync(repo, { recursive: true, force: true });
	});

	test('PreToolUse Edit claims a path lease; the second session is denied and blocked in enforce mode', () => {
		const repo = makeRepo('enforce');
		const edit = (session: string, path: string) => ({
			harness: 'claude' as const,
			event: 'PreToolUse' as const,
			sessionId: session,
			toolName: 'Edit',
			toolInput: { file_path: path },
			toolCallId: `${session}-${path}`,
			cwd: repo,
			raw: {}
		});
		expect(runHookEvent(edit('s-a', 'src/api.ts')).block).toBeUndefined();
		const denied = runHookEvent(edit('s-b', 'src/api.ts'));
		expect(denied.block).toBe(true);
		expect(denied.reason).toContain('conflict');
		rmSync(repo, { recursive: true, force: true });
	});

	test('warn mode reports the would-be conflict without blocking', () => {
		const repo = makeRepo('warn');
		const edit = (session: string, path: string) => ({
			harness: 'claude' as const,
			event: 'PreToolUse' as const,
			sessionId: session,
			toolName: 'Edit',
			toolInput: { file_path: path },
			toolCallId: `${session}-${path}`,
			cwd: repo,
			raw: {}
		});
		runHookEvent(edit('s-a', 'src/api.ts'));
		const denied = runHookEvent(edit('s-b', 'src/api.ts'));
		expect(denied.block).toBe(false);
		expect(denied.reason).toContain('conflict');
		rmSync(repo, { recursive: true, force: true });
	});

	test('observe mode records a would-be conflict but never blocks and acquires nothing', () => {
		const repo = makeRepo('observe');
		const workspace = resolveWorkspace(repo);
		expect(workspace).not.toBeNull();
		// A lease held by another session (manual claim, warn/enforce session, or crashed one).
		claimScopes({
			workspace: workspace as Workspace,
			sessionId: sessionIdFor(workspace as Workspace, 'other'),
			actor: 'other',
			scopes: ['path:src/api.ts'],
			rationale: 'other session'
		});
		const edit = (session: string) => ({
			harness: 'claude' as const,
			event: 'PreToolUse' as const,
			sessionId: session,
			toolName: 'Edit',
			toolInput: { file_path: 'src/api.ts' },
			toolCallId: `${session}-edit`,
			cwd: repo,
			raw: {}
		});
		const denied = runHookEvent(edit('s-b'));
		expect(denied.block).toBeUndefined();
		const db = new Database(process.env.ATLAS_AGENT_LOG_PATH as string);
		const wouldConflict = (db.query(
			"SELECT COUNT(*) AS n FROM telemetry WHERE payload LIKE '%\"wouldConflict\":1%'"
		).get() as { n: number }).n;
		db.close();
		expect(wouldConflict).toBe(1);
		rmSync(repo, { recursive: true, force: true });
	});

	test('PostToolUse renews the session leases', () => {
		const repo = makeRepo('warn');
		const session = 's-renew';
		runHookEvent({
			harness: 'claude', event: 'PreToolUse', sessionId: session, toolName: 'Edit',
			toolInput: { file_path: 'src/a.ts' }, toolCallId: 'c1', cwd: repo, raw: {}
		});
		const before = Date.now();
		runHookEvent({
			harness: 'claude', event: 'PostToolUse', sessionId: session, toolName: 'Edit', cwd: repo, raw: {}
		});
		const db = new Database(process.env.ATLAS_AGENT_LOG_PATH as string);
		const lease = db.query('SELECT expires_ms FROM leases WHERE session_id = ?').get(session) as {
			expires_ms: number;
		};
		db.close();
		expect(lease.expires_ms).toBeGreaterThan(before + 20 * 60_000);
		rmSync(repo, { recursive: true, force: true });
	});

	test('SessionEnd closes the session, releases leases, and writes an auto handoff', () => {
		const repo = makeRepo('warn');
		runHookEvent({
			harness: 'claude', event: 'PreToolUse', sessionId: 's-end', toolName: 'Edit',
			toolInput: { file_path: 'src/a.ts' }, toolCallId: 'c1', cwd: repo, raw: {}
		});
		runHookEvent({
			harness: 'claude', event: 'SessionEnd', sessionId: 's-end', reason: 'completed', cwd: repo, raw: {}
		});
		const db = new Database(process.env.ATLAS_AGENT_LOG_PATH as string);
		const session = db.query('SELECT status FROM sessions WHERE id = ?').get('s-end') as {
			status: string;
		};
		const leases = (db.query('SELECT COUNT(*) AS n FROM leases').get() as { n: number }).n;
		const handoff = db
			.query("SELECT summary, detail FROM events WHERE kind = 'handoff' ORDER BY seq DESC LIMIT 1")
			.get() as { summary: string; detail: string };
		db.close();
		expect(session.status).toBe('closed');
		expect(leases).toBe(0);
		expect(handoff.summary).toContain('session ended (completed)');
		expect(JSON.parse(handoff.detail).auto).toBe(true);
		rmSync(repo, { recursive: true, force: true });
	});

	test('Stop while holding leases records checkpoint-required once', () => {
		const repo = makeRepo('warn');
		const stop = {
			harness: 'claude' as const, event: 'Stop' as const, sessionId: 's-stop', cwd: repo, raw: {}
		};
		runHookEvent({
			harness: 'claude', event: 'PreToolUse', sessionId: 's-stop', toolName: 'Edit',
			toolInput: { file_path: 'src/a.ts' }, toolCallId: 'c1', cwd: repo, raw: {}
		});
		runHookEvent(stop);
		runHookEvent(stop);
		const kinds = eventKinds();
		expect(kinds.filter((kind) => kind === 'transition:checkpoint-required')).toHaveLength(1);
		rmSync(repo, { recursive: true, force: true });
	});

	test('PreCompact writes an auto checkpoint; PostCompact re-injects the snapshot', () => {
		const repo = makeRepo('warn');
		runHookEvent({
			harness: 'claude', event: 'PreCompact', sessionId: 's-c', cwd: repo, trigger: 'time', raw: {}
		});
		expect(eventKinds()).toContain('transition:checkpoint');
		const resumed = runHookEvent({
			harness: 'claude', event: 'PostCompact', sessionId: 's-c', cwd: repo, raw: {}
		});
		expect(resumed.context).toContain('atlas agent-log status');
		rmSync(repo, { recursive: true, force: true });
	});
});

describe('worktree loosening and takeover', () => {
	test('the same path lease in a different worktree does not conflict', () => {
		expect(
			claimScopes({
				workspace: ws(), sessionId: sessionIdFor(ws(), 'alice'), actor: 'alice',
				scopes: ['path:src/a.ts'], rationale: 'main', worktree: 'main'
			}).ok
		).toBe(true);
		expect(
			claimScopes({
				workspace: ws(), sessionId: sessionIdFor(ws(), 'bob'), actor: 'bob',
				scopes: ['path:src/a.ts'], rationale: 'linked', worktree: 'feature/x'
			}).ok
		).toBe(true);
		expect(
			claimScopes({
				workspace: ws(), sessionId: sessionIdFor(ws(), 'carol'), actor: 'carol',
				scopes: ['path:src/a.ts'], rationale: 'same worktree', worktree: 'feature/x'
			}).ok
		).toBe(false);
	});

	test('forced takeover deletes the conflicting grant, audits who/why, and fences the old session', () => {
		expect(
			claimScopes({
				workspace: ws(), sessionId: sessionIdFor(ws(), 'alice'), actor: 'alice',
				scopes: ['path:src/a.ts'], rationale: 'alice working'
			}).ok
		).toBe(true);
		const takeover = claimScopes({
			workspace: ws(), sessionId: sessionIdFor(ws(), 'bob'), actor: 'bob',
			scopes: ['path:src/a.ts'], rationale: 'alice is blocked', force: true
		});
		expect(takeover.ok).toBe(true);
		if (!takeover.ok) return;
		expect(takeover.leases[0].generation).toBeGreaterThan(1);
		expect(eventKinds()).toContain('transition:lease-takeover');
		const fenced = claimScopes({
			workspace: ws(), sessionId: sessionIdFor(ws(), 'alice'), actor: 'alice',
			scopes: ['path:src/a.ts'], rationale: 'alice tries again'
		});
		expect(fenced.ok).toBe(false);
	});
});

describe('checkpoint, gc, lockfile, transitions', () => {
	test('checkpoint writes structured done/next/blocked state', () => {
		const workspace = ws({ id: 'cp-ws' });
		const db = openJournal(workspace);
		try {
			checkpointEvent(db, {
				workspace, sessionId: 's', done: 'ship it', next: 'release', blocked: 'review'
			});
		} finally {
			db.close();
		}
		const db2 = new Database(process.env.ATLAS_AGENT_LOG_PATH as string);
		const row = db2
			.query("SELECT summary, detail FROM events WHERE operation = 'checkpoint' ORDER BY seq DESC LIMIT 1")
			.get() as { summary: string; detail: string };
		db2.close();
		expect(row.summary).toContain('done: ship it');
		expect(JSON.parse(row.detail).next).toBe('release');
	});

	test('gc dry-run reports and the real sweep removes expired telemetry', () => {
		const workspace = ws({ id: 'gc-ws' });
		const db = openJournal(workspace);
		recordTelemetry(db, 's', 'claude', 'PreToolUse', {}, 1_000, Date.now() - 3_600_000);
		db.close();
		const dry = runGc(workspace, true).join('\n');
		expect(dry).toContain('telemetry:  1');
		const done = runGc(workspace, false).join('\n');
		expect(done).toContain('telemetry:  1');
		const db2 = new Database(process.env.ATLAS_AGENT_LOG_PATH as string);
		const remaining = (db2.query('SELECT COUNT(*) AS n FROM telemetry').get() as { n: number }).n;
		db2.close();
		expect(remaining).toBe(0);
	});

	test('claims materialize the lockfile snapshot', () => {
		const workspace = ws({ id: 'lock-ws' });
		claimScopes({
			workspace, sessionId: sessionIdFor(workspace, 'alice'), actor: 'alice',
			scopes: ['path:src/a.ts', 'service:db'], rationale: 'lockfile test'
		});
		const path = join(workspace.stateDir, 'agent-log.lock.json');
		expect(existsSync(path)).toBe(true);
		const snapshot = JSON.parse(readFileSync(path, 'utf8')) as {
			contract: string;
			leases: { scope: string }[];
			sessions: unknown[];
		};
		expect(snapshot.contract).toBe('agent-log-v2');
		expect(snapshot.leases.map((lease) => lease.scope).sort()).toEqual([
			'path:src/a.ts',
			'service:db'
		]);
	});

	test('claims and releases generate transition events', () => {
		const workspace = ws({ id: 'tr-ws' });
		claimScopes({
			workspace, sessionId: sessionIdFor(workspace, 'alice'), actor: 'alice',
			scopes: ['path:src/a.ts'], rationale: 'transition test'
		});
		expect(eventKinds()).toContain('transition:lease-claim');
		releaseScopes(workspace, sessionIdFor(workspace, 'alice'));
		expect(eventKinds()).toContain('transition:lease-release');
	});
});