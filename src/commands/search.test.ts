import { describe, expect, test } from 'bun:test';
import { findFolder, rankProjects } from '../ranking';
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

// The regression that made `pj framelink` refuse: 25 matches, none exact, and the alphabetical
// tie-break handed it to Fractal's `_buildcheck` because an underscore sorts before every letter.
describe('rankProjects', () => {
	const p = (name: string, relativePath: string, isLocal?: boolean) => ({
		name,
		path: `/x/${relativePath}`,
		relativePath,
		host: isLocal ? 'm2' : 'fractal',
		...(isLocal ? { isLocal: true } : {})
	});

	const catalog = [
		p('_buildcheck', 'multi-stack\\framelink\\_buildcheck'),
		p('app', 'multi-stack/framelink/app', true),
		p('uqb5', 'multi-stack/framelink/app-worktrees/uqb5', true),
		p('framelink', 'other/framelink', true)
	];

	test('a local project always outranks a remote one', () => {
		const ranked = rankProjects(catalog.slice(0, 3), 'framelink');
		expect(ranked[0].name).toBe('app');
		expect(ranked.at(-1)?.name).toBe('_buildcheck');
	});

	test('an exact name beats a path hit, and shallow beats deep', () => {
		const ranked = rankProjects(catalog, 'framelink');
		expect(ranked.map((r) => r.name)).toEqual(['framelink', 'app', 'uqb5', '_buildcheck']);
	});
});

describe('findFolder', () => {
	const projects = [
		{ name: 'app', path: '/x', relativePath: 'multi-stack/framelink/app', isLocal: true }
	];

	test('picks the folder that actually holds projects', () => {
		const folders = ['_data/framelink', 'multi-stack/framelink'];
		expect(findFolder(folders, projects, 'framelink')).toBe('multi-stack/framelink');
	});

	test('only an exact last segment counts', () => {
		expect(findFolder(['multi-stack/framelink-old'], projects, 'framelink')).toBeUndefined();
	});
});
