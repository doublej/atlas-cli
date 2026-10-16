import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { END_MARKER, MARKER, POLICY_BLOCK, SHIM_CONTENT } from './policy';

const CLI = new URL('../atlas.ts', import.meta.url).pathname;
const ROOT = new URL('../..', import.meta.url).pathname;
const temp = mkdtempSync(join(tmpdir(), 'atlas-agent-log-'));
const env = { ...process.env, ATLAS_AGENT_LOG_PATH: join(temp, 'events.sqlite') };

function invoke(args: string[], cwd: string = ROOT) {
	return Bun.spawnSync(['bun', CLI, 'agent-log', ...args], { env, cwd });
}

beforeAll(() => rmSync(env.ATLAS_AGENT_LOG_PATH, { force: true }));
afterAll(() => rmSync(temp, { recursive: true, force: true }));

describe('agent-log', () => {
	test('records and closes an intent', () => {
		const started = invoke(['begin', 'edit', '--scope', 'path:CLAUDE.md', '--', 'editing rules']);
		expect(started.exitCode).toBe(0);
		const opId = started.stdout.toString().trim();
		expect(invoke(['recent']).stdout.toString()).toContain('ACTIVE');

		expect(invoke(['end', opId, '--outcome', 'ok', '--', 'rules written']).exitCode).toBe(0);
		const recent = invoke(['recent']).stdout.toString();
		expect(recent).not.toContain('ACTIVE');
		expect(recent).toContain('END');
		expect(recent).toContain('outcome=ok');
	});

	test('rejects an invented operation and names the canonical verbs', () => {
		const result = invoke(['begin', 'fix-quest-tracking-affinity', '--scope', 'path:x', '--', 'nope']);
		expect(result.exitCode).toBe(2);
		const stderr = result.stderr.toString();
		expect(stderr).toContain("unknown operation 'fix-quest-tracking-affinity'");
		expect(stderr).toContain('investigate');
	});

	test('identifies the actor as agent@repo even for a uuid session id', () => {
		const uuid = '019f88e5-746d-7012-9250-b9b737c7acd9';
		const started = Bun.spawnSync(
			['bun', CLI, 'agent-log', 'begin', 'edit', '--scope', 'artifact:actor', '--', 'uuid actor'],
			{ env: { ...env, CLAUDE_AGENT_ID: uuid }, cwd: ROOT }
		);
		expect(started.exitCode).toBe(0);
		const recent = invoke(['recent', '--scope', 'artifact:actor']).stdout.toString();
		expect(recent).toContain('37c7acd9@atlas-cli');
		expect(recent).not.toContain(uuid);
	});

	test('records an evidence-backed finding', () => {
		const result = invoke([
			'finding',
			'--scope',
			'service:demo',
			'--evidence',
			'healthcheck restarting',
			'--',
			'temporary dashboard outage'
		]);
		expect(result.exitCode).toBe(0);
		const recent = invoke(['recent', '--scope', 'service:demo']).stdout.toString();
		expect(recent).toContain('FINDING');
		expect(recent).toContain('evidence="healthcheck restarting"');
	});

	test('wraps builds and records failures', () => {
		const result = invoke(['run', 'build', '--scope', 'artifact:test', '--', 'sh', '-c', 'exit 7']);
		expect(result.exitCode).toBe(7);
		const recent = invoke(['recent', '--scope', 'artifact:test']).stdout.toString();
		expect(recent).toContain('build');
		expect(recent).toContain('outcome=failed');
	});

	test('records a durable handoff', () => {
		const result = invoke(['handoff', '--scope', 'artifact:handoff', '--', 'stopped at X; next Y']);
		expect(result.exitCode).toBe(0);
		const recent = invoke(['recent', '--scope', 'artifact:handoff']).stdout.toString();
		expect(recent).toContain('HANDOFF');
		expect(recent).toContain('stopped at X; next Y');
	});

	test('always shows the latest handoff, even outside --since', async () => {
		invoke(['handoff', '--scope', 'artifact:baton', '--', 'first baton']);
		await Bun.sleep(1100);
		invoke(['handoff', '--scope', 'artifact:baton', '--', 'second baton']);
		const recent = invoke(['recent', '--scope', 'artifact:baton', '--since', '1s']).stdout.toString();
		expect(recent).toContain('second baton');
		expect(recent).not.toContain('first baton');
	});

	test('emits machine-readable rows with --json', () => {
		invoke(['finding', '--scope', 'service:json', '--evidence', 'probe', '--', 'json probe']);
		const result = invoke(['recent', '--scope', 'service:json', '--json']);
		expect(result.exitCode).toBe(0);
		const rows = JSON.parse(result.stdout.toString()) as {
			kind: string;
			summary: string;
			scopes: string[];
			detail: Record<string, unknown>;
		}[];
		const probe = rows.find((row) => row.summary === 'json probe');
		expect(probe?.kind).toBe('finding');
		expect(probe?.scopes).toEqual(['service:json']);
		expect(probe?.detail.evidence).toBe('probe');
	});

	test('accepts concurrent writers', async () => {
		const children = Array.from({ length: 8 }, (_, index) =>
			Bun.spawn(
				['bun', CLI, 'agent-log', 'begin', 'edit', '--scope', 'artifact:parallel', '--', `writer ${index}`],
				{ env, cwd: ROOT, stdout: 'pipe', stderr: 'pipe' }
			)
		);
		expect(await Promise.all(children.map((child) => child.exited))).toEqual(Array(8).fill(0));
		const recent = invoke(['recent', '--scope', 'artifact:parallel']).stdout.toString();
		expect(recent.match(/ACTIVE/g)).toHaveLength(8);
	});
});

describe('agent-log session-end', () => {
	test('writes an auto handoff from hook stdin', () => {
		const hookJson = JSON.stringify({
			session_id: 'abc-123',
			transcript_path: '/tmp/t.jsonl',
			reason: 'exit'
		});
		const proc = Bun.spawnSync(['bun', CLI, 'agent-log', 'session-end'], {
			env,
			cwd: ROOT,
			stdin: Buffer.from(hookJson)
		});
		expect(proc.exitCode).toBe(0);
		const recent = invoke(['recent']).stdout.toString();
		expect(recent).toContain('session ended (exit)');
		expect(recent).toContain('session=abc-123');
	});

	test('exits 0 silently outside a git repo', () => {
		const dir = mkdtempSync(join(tmpdir(), 'atlas-session-end-'));
		const cleanEnv = { ...process.env };
		delete cleanEnv.ATLAS_AGENT_LOG_PATH;
		const proc = Bun.spawnSync(['bun', CLI, 'agent-log', 'session-end'], {
			env: cleanEnv,
			cwd: dir,
			stdin: Buffer.from('{}')
		});
		expect(proc.exitCode).toBe(0);
		expect(proc.stderr.toString()).toBe('');
		rmSync(dir, { recursive: true, force: true });
	});
});

describe('agent-log init', () => {
	test('bootstraps a git repo and is idempotent', () => {
		const repo = mkdtempSync(join(tmpdir(), 'atlas-agent-log-repo-'));
		Bun.spawnSync(['git', 'init', '-q'], { cwd: repo });

		expect(invoke(['init'], repo).exitCode).toBe(0);
		expect(readFileSync(join(repo, 'agent-log'), 'utf8')).toBe(SHIM_CONTENT);
		expect(readFileSync(join(repo, 'CLAUDE.md'), 'utf8')).toContain(MARKER);

		const before = readFileSync(join(repo, 'CLAUDE.md'), 'utf8');
		expect(invoke(['init'], repo).exitCode).toBe(0);
		expect(readFileSync(join(repo, 'CLAUDE.md'), 'utf8')).toBe(before);
		rmSync(repo, { recursive: true, force: true });
	});

	test('rewrites a legacy policy block in place and keeps what follows it', () => {
		const dir = mkdtempSync(join(tmpdir(), 'atlas-agent-log-legacy-'));
		const legacy = `${MARKER}\n### Shared agent journal\n\nold text\nlives in the git common directory, so linked worktrees share it without dirtying the repo.\n`;
		writeFileSync(join(dir, 'CLAUDE.md'), `# Repo\n\nintro\n\n${legacy}\n<!-- BEGIN BEADS -->\n## Beads\n`);

		expect(invoke(['init'], dir).exitCode).toBe(0);
		const once = readFileSync(join(dir, 'CLAUDE.md'), 'utf8');
		expect(once).toBe(`# Repo\n\nintro\n\n${POLICY_BLOCK}\n<!-- BEGIN BEADS -->\n## Beads\n`);
		expect(once.split(MARKER).length).toBe(2);
		expect(once).toContain(END_MARKER);

		expect(invoke(['init'], dir).exitCode).toBe(0);
		expect(readFileSync(join(dir, 'CLAUDE.md'), 'utf8')).toBe(once);
		rmSync(dir, { recursive: true, force: true });
	});

	test('skips db warm-up gracefully outside a git repo', () => {
		const dir = mkdtempSync(join(tmpdir(), 'atlas-agent-log-plain-'));
		const result = invoke(['init'], dir);
		expect(result.exitCode).toBe(0);
		expect(existsSync(join(dir, '.git'))).toBe(false);
		expect(readFileSync(join(dir, 'agent-log'), 'utf8')).toBe(SHIM_CONTENT);
		rmSync(dir, { recursive: true, force: true });
	});
});
