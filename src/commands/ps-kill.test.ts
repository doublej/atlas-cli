import { afterAll, describe, expect, test } from 'bun:test';
import { fakeApi } from '../fake-api';
import type { AppRow, ProcessInfo, StopRequest, StopResponse } from '../processes';

const T = '2026-10-01T10:00:00Z';
const row = (o: Partial<AppRow> & Pick<AppRow, 'primary' | 'pids' | 'kind' | 'name'>): AppRow => ({
	id: `${o.primary}@${T}`,
	pgid: o.primary,
	dev: true,
	cpu: 1.5,
	rss: 300 * 1_048_576,
	uptime: 7200,
	ports: [],
	flags: [],
	...o
});
const proc = (pid: number, name: string, command = `${name} --serve`, ppid = 1): ProcessInfo => ({ pid, ppid, startedAt: T, kind: 'node', name, command });

const atlas = { name: 'project-atlas', slug: 'atlas', path: '/dev/atlas' };
const SNAP = {
	generatedAt: T,
	rows: [
		row({ primary: 101, pids: [101, 102], kind: 'node', tool: 'vite', name: 'vite', project: atlas, ports: [4100] }),
		row({ primary: 201, pids: [201], kind: 'claude', name: 'claude' }),
		row({ primary: 301, pids: [301], kind: 'app', name: 'Safari', dev: false }),
		row({ primary: 401, pids: [401], kind: 'bun', name: 'bun', project: { name: 'atlas-two', slug: 'atlas-two', path: '/dev/atlas-two' } })
	],
	processes: [proc(101, 'vite'), proc(102, 'esbuild'), proc(201, 'claude'), proc(301, 'Safari'), proc(401, 'bun')]
};

/** Stops whatever it is asked to; `refuse` pids come back as a launchd job, `stuck` ones still run. */
const stopper =
	(refuse: number[] = [], stuck: number[] = []) =>
	(body: unknown): StopResponse => {
		const req = body as StopRequest;
		const status = (pid: number) => (refuse.includes(pid) ? 'refused' : req.dryRun ? 'would-stop' : stuck.includes(pid) ? 'still-running' : 'stopped');
		return {
			dryRun: Boolean(req.dryRun),
			generatedAt: T,
			results: req.targets.map((t) => ({ ...t, status: status(t.pid), ...(refuse.includes(t.pid) ? { refusal: 'launchd-job' as const, label: 'com.x.job' } : {}) })),
			wouldEnd: req.targets.filter((t) => !refuse.includes(t.pid)).map((t) => ({ ...t, ppid: 1, pgid: t.pid, kind: 'node' as const, name: `p${t.pid}`, command: 'node x' })),
			skipped: []
		};
	};

function api(stop = stopper(), snap: object = SNAP) {
	return fakeApi({
		'GET /api/processes': snap,
		'GET /api/ports/listeners': { listeners: [{ port: 4100, pid: 101, name: 'vite', startedAt: T }], updatedAt: T },
		'POST /api/processes/stop': stop
	});
}
const servers: ReturnType<typeof api>[] = [];
const fresh = (stop?: ReturnType<typeof stopper>, snap?: object) => {
	const s = api(stop, snap);
	servers.push(s);
	return s;
};
afterAll(() => servers.forEach((s) => s.stop()));

describe('atlas ps', () => {
	test('dev rows by default, with what --all would add', async () => {
		const { stdout, code } = await fresh().cli(['ps']);
		expect(code).toBe(0);
		expect(stdout).toContain('PID  KIND');
		expect(stdout).toContain('project-atlas');
		expect(stdout).not.toContain('Safari');
		expect(stdout.trim().split('\n').at(-1)).toBe('3 shown · 1 hidden (--all)');
	});

	test('--json prints the filtered rows whole; --project matches name or slug', async () => {
		const s = fresh();
		const rows = JSON.parse((await s.cli(['ps', '--project', 'atlas', '--json'])).stdout) as AppRow[];
		expect(rows.map((r) => r.primary)).toEqual([101, 401]);
		expect(rows[0].tool).toBe('vite');
		expect(s.calls[0].path).toBe('/api/processes?all=1');
		const apps = JSON.parse((await s.cli(['ps', '--all', '--kind', 'app', '--json'])).stdout) as AppRow[];
		expect(apps.map((r) => r.name)).toEqual(['Safari']);
	});

	test('an unknown kind or flag is exit 1 before any call', async () => {
		const s = fresh();
		const bad = await s.cli(['ps', '--kind', 'nope']);
		expect([bad.code, bad.stderr]).toEqual([1, expect.stringContaining('Unknown kind "nope"')]);
		expect((await s.cli(['ps', '--bogus'])).code).toBe(1);
		expect(s.calls).toHaveLength(0);
	});

	test("the API's error body reaches stderr, exit 1", async () => {
		const s = fakeApi({ 'GET /api/processes': Response.json({ error: 'ps failed: boom' }, { status: 500 }) });
		servers.push(s as ReturnType<typeof api>);
		const r = await s.cli(['ps']);
		expect([r.code, r.stderr.trim()]).toEqual([1, 'ps failed: boom']);
	});
});

describe('atlas kill', () => {
	test('--dry-run asks the server and signals nothing', async () => {
		const s = fresh();
		const r = await s.cli(['kill', '101', '--dry-run', '--tree']);
		expect(r.code).toBe(0);
		expect(r.stdout).toContain('would stop 1:');
		const posts = s.calls.filter((c) => c.method === 'POST');
		expect(posts.map((c) => c.body)).toEqual([{ targets: [{ pid: 101, startedAt: T }], tree: true, dryRun: true }]);
	});

	test(':port resolves through the listeners; --yes stops for real', async () => {
		const s = fresh();
		const r = await s.cli(['kill', ':4100', '--yes', '--json']);
		expect(r.code).toBe(0);
		expect(s.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
			'GET /api/processes?all=1&fresh=1',
			'GET /api/ports/listeners',
			'POST /api/processes/stop',
			'POST /api/processes/stop'
		]);
		expect((s.calls[3].body as StopRequest).dryRun).toBe(false);
		expect((JSON.parse(r.stdout) as StopResponse).results[0].status).toBe('stopped');
	});

	test('without a terminal and without --yes: refused, exit 4, nothing stopped', async () => {
		const s = fresh();
		const r = await s.cli(['kill', 'project-atlas']);
		expect(r.code).toBe(4);
		expect(r.stderr).toContain('--yes');
		const posts = s.calls.filter((c) => c.method === 'POST');
		expect(posts).toHaveLength(1);
		expect((posts[0].body as StopRequest).targets.map((t) => t.pid)).toEqual([101, 102]);
	});

	test('an ambiguous project lists the candidates, exit 1', async () => {
		const r = await fresh().cli(['kill', 'atla', '--dry-run']);
		expect(r.code).toBe(1);
		expect(r.stderr).toContain('/dev/atlas-two');
	});

	test('no match is exit 2; every target refused is exit 4; a survivor is exit 3', async () => {
		const none = await fresh().cli(['kill', '999', '--yes']);
		expect(none.code).toBe(2);
		const refused = await fresh(stopper([101])).cli(['kill', '101', '--yes']);
		expect(refused.code).toBe(4);
		expect(refused.stderr).toContain('atlas daemons restart com.x.job');
		const partial = await fresh(stopper([], [102])).cli(['kill', 'atlas', '--yes']);
		expect(partial.code).toBe(3);
		expect(partial.stdout).toContain('rerun with --force');
	});

	test("the server's 400 error text is the message, exit 1", async () => {
		const s = fakeApi({
			'GET /api/processes': SNAP,
			'POST /api/processes/stop': Response.json({ error: 'targets required' }, { status: 400 })
		});
		servers.push(s as ReturnType<typeof api>);
		const r = await s.cli(['kill', '101', '--yes']);
		expect([r.code, r.stderr.trim()]).toEqual([1, 'targets required']);
	});
});

describe('atlas kill <project> leaves agents, shells and its own process tree alone', () => {
	// The spawned CLI's parent is this test runner: a bun row in the project, as when an agent runs it.
	const SESSION = {
		generatedAt: T,
		rows: [
			row({ primary: 101, pids: [101], kind: 'node', tool: 'vite', name: 'vite', project: atlas }),
			row({ primary: 201, pids: [201, 202], kind: 'claude', name: 'claude', project: atlas }),
			row({ primary: 301, pids: [301], kind: 'shell', name: 'zsh', project: atlas }),
			row({ primary: 501, pids: [501], kind: 'python', name: 'notebook', project: atlas, dev: false }),
			row({ primary: process.pid, pids: [process.pid], kind: 'bun', name: 'bun', project: atlas })
		],
		processes: [
			proc(101, 'vite'),
			{ ...proc(201, 'claude'), kind: 'claude' as const },
			{ ...proc(202, 'consult-user-mcp', 'node mcp-server', 201), kind: 'mcp' as const },
			{ ...proc(301, 'zsh'), kind: 'shell' as const },
			proc(501, 'jupyter'),
			proc(process.pid, 'bun', 'bun test', process.ppid)
		]
	};
	const targets = (s: ReturnType<typeof api>) =>
		(s.calls.find((c) => c.method === 'POST')?.body as StopRequest | undefined)?.targets.map((t) => t.pid);

	test('only dev rows that are not agents, MCP servers or shells; --all adds non-dev rows', async () => {
		const s = fresh(undefined, SESSION);
		const r = await s.cli(['kill', 'project-atlas', '--dry-run']);
		expect([r.code, targets(s)]).toEqual([0, [101]]);
		expect(r.stderr).toContain(`skipping ${process.pid} bun`);
		const all = fresh(undefined, SESSION);
		await all.cli(['kill', 'atlas', '--all', '--dry-run']);
		expect(targets(all)).toEqual([101, 501]);
	});

	test('a pid in its own ancestry is refused before any stop call, exit 4', async () => {
		const s = fresh(undefined, SESSION);
		const r = await s.cli(['kill', String(process.pid), '--yes']);
		expect([r.code, targets(s)]).toEqual([4, undefined]);
		expect(r.stderr).toContain('the shell/session running it');
	});
});
