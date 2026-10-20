import { afterAll, expect, test } from 'bun:test';
import { fakeApi } from '../fake-api';

const project = { name: 'demo', path: '/dev/web/demo', relativePath: 'web/demo', devCommand: 'dev' };
const s = fakeApi({
	'GET /api/projects': { projects: [project] },
	'POST /api/run': { url: 'http://localhost:4140', bound: true, replaced: 0, log: '/tmp/demo.log', portMoved: { from: 4137, to: 4140 }, local: 'https://demo.l' }
});
afterAll(() => s.stop());

test('run says when the dev server moved off its pinned port', async () => {
	const r = await s.cli(['run', '/dev/web/demo']);
	expect([r.code, r.stdout]).toEqual([0, 'port moved 4137 -> 4140\nhttps://demo.l\n']);
	expect(JSON.parse((await s.cli(['run', '/dev/web/demo', '--json'])).stdout).portMoved).toEqual({ from: 4137, to: 4140 });
});
