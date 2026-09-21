import { describe, expect, test } from 'bun:test';
import { claudeLine, mcpLine, projectFor } from './info';

const projects = [
	{ name: 'atlas', slug: 'atlas', path: '/dev/multi-stack/project-atlas', relativePath: 'multi-stack/project-atlas' },
	{ name: 'api', slug: 'api', path: '/dev/multi-stack/project-atlas/atlas-api', relativePath: 'multi-stack/project-atlas/atlas-api' },
	{ name: 'other', slug: 'other', path: '/dev/web/other', relativePath: 'web/other' }
];

describe('projectFor', () => {
	test('exact path wins', () => {
		expect(projectFor(projects, '/dev/web/other')?.name).toBe('other');
	});

	test('a subfolder resolves to the deepest owning project', () => {
		expect(projectFor(projects, '/dev/multi-stack/project-atlas/atlas-api/src')?.name).toBe('api');
	});

	test('a sibling with a shared prefix is not a match', () => {
		expect(projectFor(projects, '/dev/web/other-thing')).toBeUndefined();
	});
});

describe('claudeLine', () => {
	test('context size and .claude/ contents read as one line', () => {
		expect(
			claudeLine({
				name: 'a',
				slug: 'a',
				path: '/a',
				relativePath: 'a',
				agentFiles: { claude: { tokens: 8659 } },
				claudeSetup: { skills: 1, rules: 3, hooks: ['SessionStart'] }
			})
		).toBe('CLAUDE.md ~8.7k · 1 skill · 3 rules · hooks: SessionStart');
	});

	test('a project with no Claude setup prints no line', () => {
		expect(claudeLine({ name: 'a', slug: 'a', path: '/a', relativePath: 'a' })).toBeUndefined();
	});
});

describe('mcpLine', () => {
	test('a server switched off for the project is marked', () => {
		expect(
			mcpLine({
				name: 'a',
				slug: 'a',
				path: '/a',
				relativePath: 'a',
				claudeSetup: { mcpServers: ['one', 'two'], mcpDisabled: ['two'] }
			})
		).toBe('one, two (off)');
	});
});
