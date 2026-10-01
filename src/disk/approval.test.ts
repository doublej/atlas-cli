import { afterAll, expect, mock, test } from 'bun:test';

const asked: unknown[][] = [];
mock.module('@inquirer/prompts', () => ({ confirm: async (...args: unknown[]) => (asked.push(args), true) }));
const { confirm } = await import('./approval');

const isTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
afterAll(() => (isTTY ? Object.defineProperty(process.stdin, 'isTTY', isTTY) : delete (process.stdin as { isTTY?: boolean }).isTTY));

test('the y/N question goes to stderr, so a piped stdout keeps only the --json document', async () => {
	Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
	expect(await confirm('Stop 1 process(es)?')).toBe(true);
	expect(asked).toEqual([[{ message: 'Stop 1 process(es)?', default: false }, { output: process.stderr }]]);
});
