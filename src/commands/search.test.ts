import { describe, expect, test } from 'bun:test';
import { splitRun } from './search';
import { cdLine } from '../util';

describe('splitRun', () => {
	test('no --run leaves the query untouched', () => {
		expect(splitRun(['project', 'atlas'])).toEqual({ query: ['project', 'atlas'], cmd: '' });
	});

	test('everything after --run is one command line', () => {
		expect(splitRun(['atlas', '--run', 'bun', 'run', 'dev'])).toEqual({
			query: ['atlas'],
			cmd: 'bun run dev'
		});
	});

	test('--run without a query is the picker + command form', () => {
		expect(splitRun(['--run', 'git status'])).toEqual({ query: [], cmd: 'git status' });
	});
});

test('cdLine quotes paths the shell would otherwise split', () => {
	expect(cdLine("/tmp/a b/it's")).toBe(`cd '/tmp/a b/it'\\''s' && echo '→ it'\\''s'`);
});
