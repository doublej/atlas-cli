import { parseArgs } from 'node:util';
import type { Command } from '../types';
import { apiGet, apiPut } from '../api';
import { die, requireUp } from '../util';
import { projectFor, type InfoProject } from './info';

const USAGE = `Usage: atlas tags [--json]                 every tag, with how many projects carry it
       atlas tags show <tag…> [--json]      the projects carrying every given tag
       atlas tags set <tag…> [--json]       replace the current project's tags (none clears them)
       atlas tags add|rm <tag…> [--json]    add or remove tags on the current project

Tags live in ~/dev/.atlas-tags.json (keyed by relativePath), never in the project, so tagging
leaves its git tree clean. They are lowercased to kebab-case on write.`;

/** `atlas tags` — the catalog's tag vocabulary, and the current project's tags. */
export const tags: Command = {
	name: 'tags',
	summary: 'list tags, find projects by tag, or tag the current project',
	usage: USAGE,
	async run(args) {
		const { values, positionals } = parseArgs({
			args,
			allowPositionals: true,
			options: { json: { type: 'boolean' } }
		});
		const [sub, ...names] = positionals;
		await requireUp();

		if (!sub) {
			const { tags: all } = await apiGet<{ tags: { tag: string; count: number }[] }>('/api/tags');
			if (values.json) return console.log(JSON.stringify(all));
			if (all.length === 0) return console.log('No tags yet. Tag this project: atlas tags add <tag>');
			for (const t of all) console.log(`${String(t.count).padStart(4)}  ${t.tag}`);
			return;
		}

		const { projects } = await apiGet<{ projects: InfoProject[] }>('/api/projects?includeArchived=true');

		if (sub === 'show') {
			if (names.length === 0) die(USAGE);
			const hits = projects.filter((p) => names.every((n) => p.tags?.includes(n)));
			if (values.json) return console.log(JSON.stringify(hits.map((p) => ({ path: p.path, tags: p.tags }))));
			for (const p of hits) console.log(`${p.relativePath.padEnd(48)} ${p.tags?.join(' ')}`);
			return;
		}

		if (!['set', 'add', 'rm'].includes(sub)) die(USAGE);
		if (sub !== 'set' && names.length === 0) die(USAGE);
		const project = projectFor(projects, process.cwd());
		if (!project) die(`No scanned project at ${process.cwd()}. Run: atlas scan`);
		const now = project.tags ?? [];
		const next =
			sub === 'set' ? names : sub === 'add' ? [...now, ...names] : now.filter((t) => !names.includes(t));
		const res = await apiPut<{ tags: string[] }>('/api/tags', { path: project.path, tags: next });
		if (values.json) return console.log(JSON.stringify(res));
		console.log(`${project.relativePath}  ${res.tags.length ? res.tags.join(' ') : '(no tags)'}`);
	}
};
