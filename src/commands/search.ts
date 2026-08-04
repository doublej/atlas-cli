import type { Command } from '../types';
import { apiGet } from '../api';
import { die, requireUp } from '../util';

type Project = { name: string; path: string; relativePath: string };
type Atlas = { projects: Project[] };

/** Exact name match first, then name prefix, then everything else. */
const rank = (p: Project, q: string): number =>
	p.name.toLowerCase() === q ? 0 : p.name.toLowerCase().startsWith(q) ? 1 : 2;

const matches = (p: Project, q: string): boolean =>
	p.name.toLowerCase().includes(q) || p.relativePath.toLowerCase().includes(q);

/** All projects matching the query, best match first. Dies when nothing matches. */
async function findProjects(args: string[]): Promise<Project[]> {
	const query = args.join(' ').trim().toLowerCase();
	if (!query) die('Usage: atlas search <query>');
	await requireUp();
	const { projects } = await apiGet<Atlas>('/api/projects');
	const found = projects
		.filter((p) => matches(p, query))
		.sort((a, b) => rank(a, query) - rank(b, query) || a.name.localeCompare(b.name));
	if (found.length === 0) die(`No projects matching "${query}". Run \`atlas help\` for commands.`);
	return found;
}

/**
 * `atlas __jump <query>` — print the best match's absolute path. Called by the
 * `atlas` zsh wrapper (shell/atlas.zsh), which cds to it.
 */
export async function jump(args: string[]): Promise<void> {
	const [best] = await findProjects(args);
	console.log(best.path);
}

/**
 * `atlas search <query>` — find projects by name/path substring.
 * Also the fallback for `atlas <query>` when <query> isn't a command.
 */
export const search: Command = {
	name: 'search',
	summary: 'find projects by name (also: atlas <query>)',
	async run(args) {
		const found = await findProjects(args);
		const width = Math.max(...found.map((p) => p.name.length));
		for (const p of found) console.log(`${p.name.padEnd(width)}  ${p.relativePath}`);
	}
};
