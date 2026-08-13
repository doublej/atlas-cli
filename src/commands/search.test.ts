import { describe, expect, test } from 'bun:test';
import { findUnknownFlag, splitRun } from './search';
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

	test('--cmd and -r are aliases of --run', () => {
		expect(splitRun(['utt', '--cmd', 'cld'])).toEqual({ query: ['utt'], cmd: 'cld' });
		expect(splitRun(['utt', '-r', 'cld'])).toEqual({ query: ['utt'], cmd: 'cld' });
	});

	test('an unknown flag is rejected, not searched for', () => {
		expect(findUnknownFlag(['utt', '--nope'])).toBe('--nope');
		expect(findUnknownFlag(splitRun(['utt', '--run', 'ls -l']).query)).toBeUndefined();
	});
});

test('cdLine quotes paths the shell would otherwise split', () => {
	expect(cdLine("/tmp/a b/it's")).toBe(`cd '/tmp/a b/it'\\''s' && echo '→ it'\\''s'`);
});
