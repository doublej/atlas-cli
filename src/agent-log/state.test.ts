import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import type { Workspace } from './project';
import { resolveWorkspace } from './project';
import { claimScopes } from './leases';
import { releaseScopes } from './lifecycle';
import { sessionIdFor } from './sessions';
import { gatherStatus } from './status';
import { runDoctor } from './doctor';
import { expandAliases, normalizeScope, pathOverlaps } from './scopes';

const CLI = new URL('../atlas.ts', import.meta.url).pathname;
const temp = mkdtempSync(join(tmpdir(), 'atlas-agent-log-v2-'));

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

function claim(
	session: string,
	scopes: string[],
	options: { ttlMs?: number; now?: number; taskId?: string; workspace?: Workspace } = {}
) {
	const workspace = options.workspace ?? ws();
	return claimScopes({
		workspace,
		sessionId: sessionIdFor(workspace, session),
		actor: session,
		scopes,
		rationale: 'test claim',
		...options
	});
}

function spawnCli(args: string[], cwd: string, env: Record<string, string>) {
	// ATLAS_AGENT_LOG_PATH must not leak from the test process — boundary tests
	// have to resolve the real workspace; explicit env overrides re-add it.
	const clean = { ...process.env };
	delete clean.ATLAS_AGENT_LOG_PATH;
	return Bun.spawnSync(['bun', CLI, 'agent-log', ...args], {
		cwd,
		env: { ...clean, ...env },
		stderr: 'pipe'
	});
}

let dbCounter = 0;
let savedLogPath: string | undefined;
beforeEach(() => {
	savedLogPath = process.env.ATLAS_AGENT_LOG_PATH;
	process.env.ATLAS_AGENT_LOG_PATH = join(temp, `state-${dbCounter++}.sqlite`);
});
afterEach(() => {
	if (savedLogPath === undefined) delete process.env.ATLAS_AGENT_LOG_PATH;
	else process.env.ATLAS_AGENT_LOG_PATH = savedLogPath;
	delete process.env.CLAUDE_AGENT_ID;
});
afterAll(() => rmSync(temp, { recursive: true, force: true }));

describe('scope overlap', () => {
	test('path scopes conflict with descendants and ancestors, but not siblings', () => {
		expect(pathOverlaps('src', 'src/api')).toBe(true);
		expect(pathOverlaps('src/api', 'src')).toBe(true);
		expect(pathOverlaps('src/api', 'src/web')).toBe(false);
		expect(pathOverlaps('src', 'test')).toBe(false);
		expect(pathOverlaps('', 'src')).toBe(true);
	});

	test('a descendant claim is denied while the ancestor is held', () => {
		const first = claim('alice', ['path:src']);
		expect(first.ok).toBe(true);
		const second = claim('bob', ['path:src/api']);
		expect(second.ok).toBe(false);
		if (!second.ok) {
			expect(second.conflicts[0].scope).toBe('path:src');
			expect(second.conflicts[0].actor).toBe('alice');
		}
	});

	test('disjoint paths and exact-key scopes do not conflict', () => {
		expect(claim('alice', ['path:src']).ok).toBe(true);
		expect(claim('bob', ['path:test', 'service:db', 'git:ref:refs/heads/other']).ok).toBe(true);
	});

	test('exact-key scopes conflict only on identical canonical keys', () => {
		expect(claim('alice', ['service:db']).ok).toBe(true);
		expect(claim('bob', ['service:db']).ok).toBe(false);
		expect(claim('bob', ['service:api']).ok).toBe(true);
		expect(claim('bob', ['git:ref:refs/heads/main']).ok).toBe(true);
		expect(claim('alice', ['git:ref:refs/heads/main']).ok).toBe(false);
		expect(claim('alice', ['git:index:main']).ok).toBe(true);
	});

	test('the whole-workspace path scope conflicts with everything', () => {
		expect(claim('alice', ['path:.']).ok).toBe(true);
		expect(claim('bob', ['path:src']).ok).toBe(false);
	});

	test('path scopes outside the boundary are rejected', () => {
		const workspace = ws({ root: process.cwd() });
		expect(() => normalizeScope('path:/etc', workspace.root)).toThrow(/outside the project boundary/);
		expect(() => normalizeScope('bogus:thing', workspace.root)).toThrow(/unknown scope type/);
	});
});

describe('expiry', () => {
	test('expired leases are reaped before a new claim succeeds', () => {
		const past = Date.now() - 10_000;
		const first = claim('alice', ['path:expiry'], { ttlMs: 1_000, now: past });
		expect(first.ok).toBe(true);
		expect(claim('bob', ['path:expiry']).ok).toBe(true);
		expect(gatherStatus(ws(), sessionIdFor(ws(), 'alice')).owned).toHaveLength(0);
	});
});

describe('renewal and release', () => {
	test('a re-entrant claim extends the lease in place, keeping the generation', () => {
		const t0 = Date.now();
		const first = claim('alice', ['path:renew'], { ttlMs: 60_000, now: t0 });
		expect(first.ok).toBe(true);
		const second = claim('alice', ['path:renew'], { ttlMs: 60_000, now: t0 + 30_000 });
		expect(second.ok).toBe(true);
		if (!second.ok) return;
		expect(second.leases).toHaveLength(1);
		expect(second.leases[0].expires_ms).toBe(t0 + 90_000);
		if (first.ok) expect(second.leases[0].generation).toBe(first.leases[0].generation);
	});

	test('release frees scopes, optionally filtered by scope', () => {
		expect(claim('alice', ['path:a', 'path:b']).ok).toBe(true);
		expect(releaseScopes(ws(), sessionIdFor(ws(), 'alice'), ['path:a'])).toBe(1);
		const status = gatherStatus(ws(), sessionIdFor(ws(), 'alice'));
		expect(status.owned.map((lease) => lease.scope)).toEqual(['path:b']);
		expect(releaseScopes(ws(), sessionIdFor(ws(), 'alice'))).toBe(1);
		expect(gatherStatus(ws(), sessionIdFor(ws(), 'alice')).owned).toHaveLength(0);
	});
});

describe('aliases', () => {
	test('workspace aliases expand to primitive scopes before the claim', () => {
		const workspace = ws({
			id: 'alias-boundary',
			aliases: { 'component:api': ['path:api/src', 'service:api'] }
		});
		const result = claim('alice', ['component:api'], { workspace });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.leases.map((lease) => lease.scope).sort()).toEqual(['path:api/src', 'service:api']);
		expect(claim('bob', ['path:api/src'], { workspace }).ok).toBe(false);
	});

	test('aliases may chain and cycles terminate', () => {
		expect(expandAliases(['a'], { a: ['b', 'service:x'], b: ['service:y'] })).toEqual([
			'service:y',
			'service:x'
		]);
		expect(expandAliases(['a'], { a: ['b'], b: ['a'] })).toEqual([]);
	});
});

describe('nested workspaces and boundaries', () => {
	test('nearest .atlas wins over a nested git repo', () => {
		const root = mkdtempSync(join(tmpdir(), 'atlas-boundary-'));
		const sub = join(root, 'nested-repo');
		Bun.spawnSync(['mkdir', '-p', sub], {});
		Bun.spawnSync(['git', 'init', '-q'], { cwd: sub });
		writeFileSync(
			join(root, '.atlas'),
			JSON.stringify({
				description: '',
				'agent-log': {
					mode: 'warn',
					aliases: { 'component:api': ['path:api/src', 'service:api'] }
				}
			})
		);
		const env = { XDG_DATA_HOME: join(temp, 'xdg'), CLAUDE_AGENT_ID: 'nested-agent' };
		const claim = spawnCli(['claim', 'component:api', '--', 'nested claim'], sub, env);
		expect(claim.exitCode).toBe(0);
		const status = spawnCli(['status', '--json'], sub, env);
		expect(status.exitCode).toBe(0);
		const data = JSON.parse(status.stdout.toString()) as {
			project: { root: string; boundary: string };
			owned: { scope: string }[];
		};
		expect(data.project.root).toBe(realpathSync(root));
		expect(data.project.boundary).toBe('atlas');
		expect(data.owned.map((lease) => lease.scope).sort()).toEqual(['path:api/src', 'service:api']);
		rmSync(root, { recursive: true, force: true });
	});

	test('independent projects never conflict on the same relative path', () => {
		const repoA = mkdtempSync(join(tmpdir(), 'atlas-repo-a-'));
		const repoB = mkdtempSync(join(tmpdir(), 'atlas-repo-b-'));
		Bun.spawnSync(['git', 'init', '-q'], { cwd: repoA });
		Bun.spawnSync(['git', 'init', '-q'], { cwd: repoB });
		const env = { CLAUDE_AGENT_ID: 'shared-agent' };
		expect(spawnCli(['claim', 'path:src/main.ts', '--', 'same scope'], repoA, env).exitCode).toBe(0);
		expect(spawnCli(['claim', 'path:src/main.ts', '--', 'same scope'], repoB, env).exitCode).toBe(0);
		rmSync(repoA, { recursive: true, force: true });
		rmSync(repoB, { recursive: true, force: true });
	});
});

describe('concurrent claims', () => {
	test('exactly one of several racing sessions wins the scope', () => {
		const repo = mkdtempSync(join(tmpdir(), 'atlas-race-'));
		Bun.spawnSync(['git', 'init', '-q'], { cwd: repo });
		const results = Array.from({ length: 6 }, (_, index) =>
			spawnCli(['claim', 'path:src/race', '--', 'racing'], repo, {
				CLAUDE_AGENT_ID: `race-${index}`,
				ATLAS_AGENT_LOG_PATH: join(temp, 'race.sqlite')
			})
		);
		const winners = results.filter((result) => result.exitCode === 0);
		expect(winners).toHaveLength(1);
		expect(results.filter((result) => result.exitCode === 2 && result.stderr.toString().includes('conflict'))).toHaveLength(5);
		rmSync(repo, { recursive: true, force: true });
	});
});

describe('doctor', () => {
	test('reports a healthy journal and exits 0', () => {
		const repo = mkdtempSync(join(tmpdir(), 'atlas-doctor-'));
		Bun.spawnSync(['git', 'init', '-q'], { cwd: repo });
		const env = { CLAUDE_AGENT_ID: 'doc-agent', ATLAS_AGENT_LOG_PATH: join(temp, 'doctor.sqlite') };
		expect(spawnCli(['claim', 'path:src/a', '--', 'doctor probe'], repo, env).exitCode).toBe(0);
		const result = spawnCli(['doctor'], repo, env);
		expect(result.exitCode).toBe(0);
		expect(result.stdout.toString()).toContain('schema:    v3 (ok)');
		rmSync(repo, { recursive: true, force: true });
	});

	test('flags stale sessions and expired leases', () => {
		const repo = mkdtempSync(join(tmpdir(), 'atlas-doctor-'));
		Bun.spawnSync(['git', 'init', '-q'], { cwd: repo });
		const env = { CLAUDE_AGENT_ID: 'doc-agent', ATLAS_AGENT_LOG_PATH: join(temp, 'doctor.sqlite') };
		spawnCli(['claim', 'path:src/a', '--', 'doctor probe'], repo, env);
		const db = new Database(env.ATLAS_AGENT_LOG_PATH);
		db.query(
			`INSERT INTO sessions (id, boundary_id, actor, started_at, last_heartbeat, status)
			 VALUES ('stale-session', ?, 'ghost', ?, ?, 'active')`
		).run('x', Date.now() - 25 * 3_600_000, Date.now() - 25 * 3_600_000);
		db.query(
			`INSERT INTO leases (boundary_id, scope, scope_type, normalized, session_id, task_id, generation, heartbeat_ms, expires_ms, rationale)
			 VALUES (?, 'path:ghost', 'path', 'ghost', 'stale-session', 't-ghost', 1, ?, ?, 'ghost')`
		).run('x', Date.now() - 3_600_000, Date.now() - 60_000);
		db.close();
		const result = spawnCli(['doctor'], repo, env);
		expect(result.exitCode).toBe(1);
		const out = result.stdout.toString();
		expect(out).toContain('stale session');
		expect(out).toContain('expired lease');
		rmSync(repo, { recursive: true, force: true });
	});

	test('flags unresolved alias scopes in the .atlas metadata', () => {
		const repo = mkdtempSync(join(tmpdir(), 'atlas-doctor-'));
		Bun.spawnSync(['git', 'init', '-q'], { cwd: repo });
		writeFileSync(
			join(repo, '.atlas'),
			JSON.stringify({ 'agent-log': { mode: 'warn', aliases: { 'component:api': ['bogus:x'] } } })
		);
		const env = { CLAUDE_AGENT_ID: 'doc-agent', ATLAS_AGENT_LOG_PATH: join(temp, 'doctor.sqlite') };
		const result = spawnCli(['doctor'], repo, env);
		expect(result.exitCode).toBe(1);
		expect(result.stdout.toString()).toContain('unresolved alias');
		rmSync(repo, { recursive: true, force: true });
	});
});

describe('status', () => {
	test('reports the task, owned leases, generation, and project', () => {
		const workspace = ws();
		claim('alice', ['path:src', 'service:db'], { taskId: 't-1' });
		claim('bob', ['path:test', 'service:api']);
		const data = gatherStatus(workspace, sessionIdFor(workspace, 'alice'));
		expect(data.project.root).toBe(workspace.root);
		expect(data.session?.actor).toBe('alice');
		expect(data.task?.id).toBe('t-1');
		expect(data.owned.map((lease) => lease.scope).sort()).toEqual(['path:src', 'service:db']);
		expect(data.owned.every((lease) => lease.generation >= 1)).toBe(true);
		expect(data.conflicts).toHaveLength(0);
		expect(data.peers.map((peer) => peer.actor)).toContain('bob');
	});

	test('lists overlapping leases held by others as conflicts', () => {
		claim('alice', ['path:src']);
		// Exclusive claims prevent overlap, so an injected row stands in for the
		// takeover case (Phase 3) — the read path must still surface it.
		const db = new Database(process.env.ATLAS_AGENT_LOG_PATH as string);
		db.query(
			`INSERT INTO leases (boundary_id, scope, scope_type, normalized, session_id, task_id,
				generation, heartbeat_ms, expires_ms, rationale)
			 VALUES ('test-boundary', 'path:src/api', 'path', 'src/api', 'ghost', 't-ghost', 1, ?, ?, 'injected')`
		).run(Date.now(), Date.now() + 60_000);
		db.close();
		const data = gatherStatus(ws(), sessionIdFor(ws(), 'alice'));
		expect(data.conflicts.map((conflict) => conflict.scope)).toContain('path:src/api');
	});

	test('resolves the boundary from a bare cwd (git fallback)', () => {
		const repo = mkdtempSync(join(tmpdir(), 'atlas-resolve-'));
		Bun.spawnSync(['git', 'init', '-q'], { cwd: repo });
		const workspace = resolveWorkspace(repo);
		expect(workspace).not.toBeNull();
		expect(workspace?.boundary).toBe('git');
		expect(workspace?.mode).toBe('observe');
		expect(workspace?.stateDir).toBe(realpathSync(join(repo, '.git')));
		rmSync(repo, { recursive: true, force: true });
	});

	test('runDoctor returns ok for a fresh observe-mode workspace', () => {
		expect(runDoctor(ws({ id: 'doctor-ws', mode: 'observe' })).ok).toBe(true);
	});
});