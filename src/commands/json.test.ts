// `--json` on every command that prints data: one parseable document on stdout, text-mode exit codes.
import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeApi } from '../fake-api';

const outside = realpathSync(mkdtempSync(join(tmpdir(), 'atlas-json-')));
const project = {
	name: 'demo',
	slug: 'demo',
	path: '/dev/web/demo',
	relativePath: 'web/demo',
	isLocal: true,
	host: 'm2',
	git: 'clean',
	gitBranch: 'main',
	devCommand: 'dev',
	flow: { policy: 'trunk', trunk: 'main' }
};
const node = (path: string, kind: string) => ({ id: path, path, label: path, kind, parent: null, preview: { tokens: 10, lines: 1 }, tokensAccumulated: 10 });

const s = fakeApi({
	'GET /api/projects': { baseDir: '/dev', folders: [], projects: [project], hosts: [{ id: 'm2', root: '~/dev', scannedAt: 't', status: 'ok', projectCount: 1 }] },
	'GET /api/ports/audit': { collisions: [{ port: 4100, sources: [] }], unmanaged: [] },
	'POST /api/refresh': { projects: [project], frameworks: ['vite'] },
	'POST /api/run': { url: 'http://localhost:4100', bound: false, exited: true, replaced: 0, log: '/tmp/demo.log' },
	'GET /api/templates': { templates: [{ family: 'ts', name: 'kit', path: '/t', variables: [{ name: 'a' }] }], errors: [], lint: [{ level: 'error', code: 'x', message: 'bad' }] },
	'GET /api/services': { services: [{ slug: 'atlas', name: 'atlas', port: 47891, mode: 'bridge', local: 'https://a' }] },
	'GET /api/claude-tree': (_: unknown, url: URL) =>
		url.searchParams.get('search') ? [{ path: '/dev/CLAUDE.md', matches: [] }] : url.searchParams.get('path') ? { content: '# hi' } : [node('/dev/CLAUDE.md', 'root')]
});
afterAll(() => {
	s.stop();
	rmSync(outside, { recursive: true, force: true });
});

const json = async (...args: string[]) => {
	const r = await s.cli(args);
	return { code: r.code, data: JSON.parse(r.stdout) };
};

test('search: the text columns plus the absolute path', async () => {
	expect(await json('search', 'demo', '--json')).toEqual({
		code: 0,
		data: [{ name: 'demo', slug: 'demo', path: '/dev/web/demo', relativePath: 'web/demo', host: 'm2', isLocal: true }]
	});
	expect((await json('demo', '--json')).data).toHaveLength(1); // the `atlas <query>` fallback
});

test('ports keeps exit 1 on collisions; scan prints counts only', async () => {
	expect((await json('ports', '--json')).code).toBe(1);
	expect(await json('scan', '--json')).toEqual({ code: 0, data: { projects: 1, frameworks: 1 } });
});

test('run prints the RunResult even when the server exited, and still exits 1', async () => {
	expect(await json('run', '/dev/web/demo', '--json')).toEqual({
		code: 1,
		data: { url: 'http://localhost:4100', bound: false, exited: true, replaced: 0, log: '/tmp/demo.log' }
	});
});

test('templates list and lint', async () => {
	expect((await json('templates', '--json')).data).toEqual([{ family: 'ts', name: 'kit', version: null, vars: 1, status: 'ok' }]);
	const lint = await json('templates', 'lint', '--json');
	expect([lint.code, lint.data.lint[0].code]).toEqual([1, 'x']);
});

test('flow resolves a subfolder to its project; audit splits the repos', async () => {
	expect((await json('flow', 'status', '/dev/web/demo/src', '--json')).data.name).toBe('demo');
	expect((await json('flow', 'audit', '--json')).data).toEqual({ ready: ['web/demo'], blocked: [], done: [], skipped: 0 });
});

test('hosts, services and the tree commands', async () => {
	const hosts = (await json('hosts', '--json')).data as { id: string; status?: string }[];
	expect(hosts.find((h) => h.id === 'm2')?.status).toBe('ok');
	expect((await json('services', '--json')).data[0].mode).toBe('bridge');
	expect((await json('tree', 'view', '/dev', '--json')).data[0].kind).toBe('root');
	expect((await json('tree', 'search', 'hi', '/dev', '--json')).data[0].path).toBe('/dev/CLAUDE.md');
	expect((await json('tree', 'compose', '/dev', '--json')).data).toEqual([{ path: '/dev/CLAUDE.md', kind: 'root', content: '# hi' }]);
});

test('brief --json is null outside a project; its text stays silent', async () => {
	const run = (args: string[]) =>
		Bun.spawn(['bun', new URL('../atlas.ts', import.meta.url).pathname, ...args], { cwd: outside, stdout: 'pipe' });
	expect(await new Response(run(['brief', '--json']).stdout).text()).toBe('null\n');
	expect(await new Response(run(['brief']).stdout).text()).toBe('');
});
