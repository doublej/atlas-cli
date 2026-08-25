import { describe, expect, test } from 'bun:test';
import { projectFor } from './info';

const projects = [
	{ name: 'atlas', path: '/dev/multi-stack/project-atlas', relativePath: 'multi-stack/project-atlas' },
	{ name: 'api', path: '/dev/multi-stack/project-atlas/atlas-api', relativePath: 'multi-stack/project-atlas/atlas-api' },
	{ name: 'other', path: '/dev/web/other', relativePath: 'web/other' }
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
