import { expect, test } from 'bun:test';
import { COMMANDS } from '../registry';
import { completionScript } from './install-autocompletion';

const CLI = new URL('../atlas.ts', import.meta.url).pathname;
// No ATLAS_API needed: nothing here reaches the API. stdin is not a terminal.
const atlas = (...args: string[]) => Bun.spawnSync(['bun', CLI, ...args], { stdin: 'ignore' });

test('--help prints the full usage of new, flow and tree', () => {
	expect(atlas('new', '--help').stdout.toString()).toContain('--category');
	expect(atlas('flow', '--help').stdout.toString()).toContain('atlas flow audit');
	expect(atlas('tree', '--help').stdout.toString()).toContain('compose [path]');
});

test('new without a terminal fails fast and names the non-interactive form', () => {
	const r = atlas('new');
	expect(r.exitCode).toBe(1);
	expect(r.stdout.toString()).toBe('');
	expect(r.stderr.toString()).toContain('atlas new <family/name> --name');
});

test('the completion and the primer list every registered command', () => {
	const script = completionScript(COMMANDS);
	const prime = JSON.parse(atlas('prime', '--json').stdout.toString()) as { commands: { name: string }[] };
	for (const name of ['ps', 'kill', 'stop', 'set', 'daemons']) {
		expect(script).toContain(`'${name}:`);
		expect(prime.commands.map((c) => c.name)).toContain(name);
	}
	expect(prime.commands).toHaveLength(COMMANDS.length);
});
