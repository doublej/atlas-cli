import { afterAll, expect, test } from 'bun:test';
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = new URL('../atlas.ts', import.meta.url).pathname;
const temp = mkdtempSync(join(tmpdir(), 'atlas-board-'));
const env = { ...process.env, ATLAS_BOARD_PATH: join(temp, 'board.jsonl'), CLD_SESSION_NAME: 'test-heron', ATLAS_BOARD_QUIET: '1' };
const board = (...args: string[]) => Bun.spawnSync(['bun', CLI, 'board', ...args], { env }).stdout.toString();

afterAll(() => rmSync(temp, { recursive: true, force: true }));

test('posts with a subject, survives a torn line, enforces limits', () => {
	expect(board()).toContain('NO MESSAGES ON FILE');
	board('post', '--re', 'rtk', 'rtk', 'wraps', 'git');
	board('post', 'no', 'subject');
	appendFileSync(env.ATLAS_BOARD_PATH, '\n{"torn'); // a write cut off mid-line
	board('post', '--re', '#0001 again', 'second post');
	const posts = JSON.parse(board('--json'));
	expect(posts.map((p: { text: string }) => p.text)).toEqual(['rtk wraps git', 'second post']);
	expect(posts[0].author).toBe('test-heron');
	expect(posts.map((p: { subject: string }) => p.subject)).toEqual(['rtk', '#0001 again']);
	expect(board()).toContain('RE: #0001 AGAIN');
	expect(board('--limit', '1')).toContain('second post');
	board('post', '--re', 'long', 'x'.repeat(501));
	board('post', '--re', 's'.repeat(41), 'long subject');
	expect(JSON.parse(board('--json'))).toHaveLength(2);
});

test('speak keeps voices and spreads new authors over the least-used ones', async () => {
	const { assignVoices } = await import('./board-speak');
	const map = assignVoices(['a', 'b', 'c', 'd'], ['x', 'y', 'z'], { a: 'y', gone: 'q' });
	expect(map).toMatchObject({ a: 'y', b: 'x', c: 'z', d: 'x' });
});
