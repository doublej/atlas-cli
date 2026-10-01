import { afterAll, describe, expect, test } from 'bun:test';
import { fakeApi } from '../fake-api';

const PROJECTS = { projects: [{ name: 'demo', slug: 'demo', path: '/dev/web/demo', relativePath: 'web/demo' }] };
const servers: ReturnType<typeof fakeApi>[] = [];
const api = (routes: Record<string, unknown>) => {
	const s = fakeApi({ 'GET /api/projects': PROJECTS, ...routes });
	servers.push(s);
	return s;
};
afterAll(() => servers.forEach((s) => s.stop()));

const verdicts = {
	free: { slug: 'new', status: 'free', local: 'https://new.l', remote: null },
	current: { slug: 'demo', status: 'current', local: 'https://demo.l', remote: null },
	taken: { slug: 'atlas', status: 'taken', holder: { kind: 'service', name: 'atlas' }, local: 'https://atlas.l', remote: null },
	invalid: { slug: '-x', status: 'invalid', reason: 'edge hyphen', local: '', remote: null }
};

describe('atlas hostnames check', () => {
	test('prints the verdict; exit 0 only for free and current', async () => {
		const s = api({ 'GET /api/hostnames/check': (_: unknown, url: URL) => verdicts[url.searchParams.get('slug') as keyof typeof verdicts] });
		const run = async (slug: string) => {
			const r = await s.cli(['hostnames', 'check', slug, '/dev/web/demo/src']);
			return [r.code, r.stdout.trim()];
		};
		expect(await run('free')).toEqual([0, 'free']);
		expect(await run('current')).toEqual([0, 'current']);
		expect(await run('taken')).toEqual([1, 'taken by service atlas']);
		expect(await run('invalid')).toEqual([1, 'invalid: edge hyphen']);
		// The owning project's path, not the subfolder, is what `current` is judged against.
		expect(s.calls.at(-1)?.path).toBe('/api/hostnames/check?slug=invalid&path=%2Fdev%2Fweb%2Fdemo');
	});

	test('--json is the response; a missing slug is a usage error', async () => {
		const s = api({ 'GET /api/hostnames/check': verdicts.taken });
		const r = await s.cli(['hostnames', 'check', 'atlas', '--json']);
		expect([r.code, JSON.parse(r.stdout).holder.name]).toEqual([1, 'atlas']);
		expect((await s.cli(['hostnames', 'check'])).code).toBe(1);
	});
});

describe('atlas hostnames doctor', () => {
	const items = [
		{ id: 'unsynced:demo', kind: 'unsynced', slug: 'demo', detail: 'row not on the NAS', fix: { label: 'push it' } },
		{ id: 'orphan-site-file:x', kind: 'orphan-site-file', detail: 'x.caddy is not ours', fix: null }
	];

	test('reports drift with exit 1, a clean run with exit 0', async () => {
		const r = await api({ 'GET /api/hostnames/doctor': { checkedAt: 't', items } }).cli(['hostnames', 'doctor']);
		expect(r.code).toBe(1);
		expect(r.stdout).toContain('→ push it');
		expect(r.stdout).toContain('→ report only');
		expect(r.stdout).toContain('Fix: atlas hostnames doctor --fix');
		const clean = await api({ 'GET /api/hostnames/doctor': { checkedAt: 't', items: [] } }).cli(['hostnames', 'doctor', '--json']);
		expect([clean.code, JSON.parse(clean.stdout).items]).toEqual([0, []]);
	});

	test('--fix posts, prints each result and exits 1 while anything remains', async () => {
		const s = api({
			'POST /api/hostnames/doctor': { results: [{ id: 'unsynced:demo', ok: true }], items: [items[1]] }
		});
		const r = await s.cli(['hostnames', 'doctor', '--fix']);
		expect(r.code).toBe(1);
		expect(r.stdout).toContain('✓ unsynced:demo');
		expect(r.stdout).toContain('Still drifting (1):');
		expect(s.calls.at(-1)).toEqual({ method: 'POST', path: '/api/hostnames/doctor', body: {} });
	});
});

describe('atlas hostnames list/assign', () => {
	test('text unchanged, --json is the raw answer', async () => {
		const rows = [{ slug: 'demo', path: '/dev/web/demo', local: 'https://demo.l' }];
		const s = api({ 'GET /api/hostnames': rows, 'POST /api/hostnames': { slug: 'demo', port: 4100, nasSynced: false } });
		expect((await s.cli(['hostnames'])).stdout).toBe(`${'demo'.padEnd(24)} https://demo.l\n`);
		expect(JSON.parse((await s.cli(['hostnames', '--json'])).stdout)).toEqual(rows);
		expect((await s.cli(['hostnames', 'assign', '/dev/web/demo'])).stdout).toBe('Port reserved (4100) — NAS push failed, not synced.\n');
		expect(JSON.parse((await s.cli(['hostnames', 'assign', '/dev/web/demo', '--json'])).stdout).port).toBe(4100);
	});
});
