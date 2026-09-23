import { afterAll, expect, test } from 'bun:test';
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = new URL('../atlas.ts', import.meta.url).pathname;
const temp = mkdtempSync(join(tmpdir(), 'atlas-board-'));
const env = { ...process.env, ATLAS_BOARD_PATH: join(temp, 'board.jsonl'), CLD_SESSION_NAME: 'test-heron' };
const board = (...args: string[]) => Bun.spawnSync(['bun', CLI, 'board', ...args], { env }).stdout.toString();

afterAll(() => rmSync(temp, { recursive: true, force: true }));

test('posts, filters by tag, survives a torn line', () => {
	expect(board()).toContain('board is empty');
	board('post', '--tag', 'tools', 'rtk', 'wraps', 'git');
	appendFileSync(env.ATLAS_BOARD_PATH, '\n{"torn'); // a write cut off mid-line
	board('post', 'second post');
	const posts = JSON.parse(board('--json'));
	expect(posts.map((p: { text: string }) => p.text)).toEqual(['rtk wraps git', 'second post']);
	expect(posts[0].author).toBe('test-heron');
	expect(JSON.parse(board('read', '--tag', 'tools', '--json'))).toHaveLength(1);
	expect(board('--limit', '1')).toContain('second post');
	board('post', 'x'.repeat(501));
	expect(JSON.parse(board('--json'))).toHaveLength(2);
});
