import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeApi } from '../fake-api';
import { parseValue } from './set';

// A real folder: `set` acts on the project owning the child's cwd.
const root = realpathSync(mkdtempSync(join(tmpdir(), 'atlas-cli-')));
mkdirSync(join(root, 'src'));
const PROJECTS = { projects: [{ name: 'demo', slug: 'demo', path: root, relativePath: 'web/demo' }] };

const servers: ReturnType<typeof fakeApi>[] = [];
const api = (routes: Record<string, unknown>) => {
	const s = fakeApi({ 'GET /api/projects': PROJECTS, ...routes });
	servers.push(s);
	return s;
};
afterAll(() => {
	servers.forEach((s) => s.stop());
	rmSync(root, { recursive: true, force: true });
});

describe('atlas stop', () => {
	test("stops the owning project's dev server via DELETE /api/run", async () => {
		const s = api({ 'DELETE /api/run': { stopped: true } });
		const r = await s.cli(['stop', join(root, 'src'), '--json']);
		expect(r.code).toBe(0);
		expect(JSON.parse(r.stdout)).toEqual({ name: 'demo', path: root, stopped: true });
		expect(s.calls.at(-1)).toEqual({ method: 'DELETE', path: '/api/run', body: { path: root } });
	});

	test("not running is still exit 0; an API error is exit 1 with the server's text", async () => {
		expect((await api({ 'DELETE /api/run': { stopped: false } }).cli(['stop', root])).stdout).toBe("demo wasn't running\n");
		const bad = await api({
			'DELETE /api/run': Response.json({ error: "path is not in this machine's catalog" }, { status: 400 })
		}).cli(['stop', root]);
		expect([bad.code, bad.stderr.trim()]).toEqual([1, "path is not in this machine's catalog"]);
		expect((await api({}).cli(['stop', '/nowhere'])).code).toBe(1);
	});
});

describe('atlas set', () => {
	const patched = (s: ReturnType<typeof fakeApi>) => s.calls.find((c) => c.method === 'PATCH')?.body;

	test('JSON values parse, string keys stay strings, --unset sends null', async () => {
		const s = api({ 'PATCH /api/atlas': { atlas: {} } });
		expect((await s.cli(['set', 'port', '4100'], join(root, 'src'))).stdout).toBe('port = 4100  (web/demo/.atlas)\n');
		expect(patched(s)).toEqual({ path: root, patch: { port: 4100 } });
		await s.cli(['set', 'slug', '2048'], root);
		expect(s.calls.at(-1)?.body).toEqual({ path: root, patch: { slug: '2048' } });
		expect((await s.cli(['set', '--unset', 'slug'], root)).stdout).toBe('slug cleared  (web/demo/.atlas)\n');
		expect(s.calls.at(-1)?.body).toEqual({ path: root, patch: { slug: null } });
	});

	test('prints the moved hostname when the response carries one', async () => {
		const hostname = { slug: 'demo2', local: 'https://demo2.atlas.local.example', remote: null, state: 'issuing', nasSynced: true };
		const s = api({ 'PATCH /api/atlas': { atlas: { slug: 'demo2' }, hostname } });
		const r = await s.cli(['set', 'slug', 'demo2'], root);
		expect(r.stdout).toBe('slug = demo2  (web/demo/.atlas)\nhostname https://demo2.atlas.local.example  (issuing)\n');
		expect(JSON.parse((await s.cli(['set', 'slug', 'demo2', '--json'], root)).stdout).hostname.state).toBe('issuing');
	});

	test('an unknown key or a missing value is exit 1 before any write', async () => {
		const s = api({ 'PATCH /api/atlas': { atlas: {} } });
		const typo = await s.cli(['set', 'prot', '4100'], root);
		expect([typo.code, typo.stderr]).toEqual([1, expect.stringContaining('Unknown .atlas key "prot"')]);
		expect((await s.cli(['set', 'port'], root)).code).toBe(1);
		expect(s.calls.filter((c) => c.method === 'PATCH')).toHaveLength(0);
	});

	test('each key takes its own type: loose input, strict value, undefined when it is not one', () => {
		const cases: [string, string, unknown][] = [
			['port', '4100', 4100],
			['port', '41.5', undefined],
			['port', '"4100"', undefined],
			['archived', 'false', false],
			['archived', 'no', undefined],
			['devPublic', 'yes', undefined],
			['domains', 'foo.org', ['foo.org']],
			['domains', 'a.com, b.com', ['a.com', 'b.com']],
			['domains', '["a.com"]', ['a.com']],
			['domains', '42', undefined],
			['flow', '{"trunk":"main"}', { trunk: 'main' }],
			['flow', 'gitflow', undefined],
			['agent-log', '["warn"]', undefined],
			['umami', 'c0ffee-1d', 'c0ffee-1d'],
			['umami', '{"instance":"https://u.example"}', undefined],
			['slug', '2048', '2048'],
			['description', ' ', undefined]
		];
		expect(cases.map(([key, raw]) => [key, raw, parseValue(key, raw)])).toEqual(cases);
	});

	test('a value of the wrong type is exit 1 naming the type, before any write', async () => {
		const s = api({ 'PATCH /api/atlas': { atlas: {} } });
		const r = await s.cli(['set', 'archived', 'no'], root);
		expect([r.code, r.stderr.trim()]).toEqual([1, 'archived takes true or false, not "no"']);
		expect(s.calls.filter((c) => c.method === 'PATCH')).toHaveLength(0);
		await s.cli(['set', 'domains', 'foo.org'], root);
		expect(patched(s)).toEqual({ path: root, patch: { domains: ['foo.org'] } });
	});

	test('a 409 from the server is the message', async () => {
		const error = 'slug "atlas" is taken by service atlas';
		const r = await api({ 'PATCH /api/atlas': Response.json({ error }, { status: 409 }) }).cli(['set', 'slug', 'atlas'], root);
		expect([r.code, r.stderr.trim()]).toEqual([1, error]);
	});
});

describe('atlas daemons', () => {
	const daemon = (label: string, name: string, extra = {}) => ({
		label,
		name,
		state: { pid: 42, lastExitStatus: null, status: 'running' },
		scheduled: false,
		portInUse: null,
		stale: false,
		...extra
	});
	const DAEMONS = {
		daemons: [
			daemon('com.jurrejan.atlas-api', 'Atlas API', { port: 47891, portInUse: true, selfManaged: true }),
			daemon('com.jurrejan.reminders-bridge', 'Reminders Bridge'),
			daemon('com.jurrejan.dlwatcher', 'DL Watcher', { state: { pid: null, lastExitStatus: 1, status: 'error' } })
		]
	};

	test('lists live state; --json is the array', async () => {
		const s = api({ 'GET /api/daemons': DAEMONS });
		const text = (await s.cli(['daemons'])).stdout;
		expect(text).toContain('self-managed');
		expect(text).toContain('error (exit 1)');
		expect(JSON.parse((await s.cli(['daemons', '--json'])).stdout)).toHaveLength(3);
	});

	test('restart matches a unique part of the label or name', async () => {
		const s = api({ 'GET /api/daemons': DAEMONS, 'POST /api/daemons/com.jurrejan.reminders-bridge': { action: 'restart', state: { pid: 77, status: 'running' } } });
		const r = await s.cli(['daemons', 'restart', 'remind']);
		expect([r.code, r.stdout]).toEqual([0, 'restarted Reminders Bridge — running 77\n']);
		expect(s.calls.at(-1)?.body).toEqual({ action: 'restart' });
	});

	test('refuses atlas-api and ambiguity before calling; a 403 is the message', async () => {
		const s = api({ 'GET /api/daemons': DAEMONS, 'POST /api/daemons/com.jurrejan.dlwatcher': Response.json({ error: 'writes disabled' }, { status: 403 }) });
		const self = await s.cli(['daemons', 'restart', 'atlas-api']);
		expect([self.code, self.stderr]).toEqual([1, expect.stringContaining('self-managed')]);
		expect((await s.cli(['daemons', 'restart', 'com.jurrejan'])).stderr).toContain('matches several daemons');
		expect(s.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
		const denied = await s.cli(['daemons', 'restart', 'dlwatcher']);
		expect([denied.code, denied.stderr.trim()]).toEqual([1, 'writes disabled']);
	});
});
