import type { Command } from '../types';
import { apiGet } from '../api';
import { cdLine, die, requireUp, shellExec } from '../util';

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

/** `--run` and its aliases: everything after one of these is the command line. */
export const RUN_FLAGS = ['--run', '--cmd', '-r'];

/** Split `--run <cmd…>` off the argv — everything after the flag is one command line. */
/** A flag left in the query would otherwise be searched for as if it were a project name. */
export const findUnknownFlag = (query: string[]): string | undefined =>
	query.find((a) => a.startsWith('-'));

export function splitRun(args: string[]): { query: string[]; cmd: string } {
	const i = args.findIndex((a) => RUN_FLAGS.includes(a));
	const query = i === -1 ? args : args.slice(0, i);
	const bad = findUnknownFlag(query);
	if (bad) die(`Unknown flag "${bad}". Usage: atlas jump [query] --run <command>`);
	if (i === -1) return { query, cmd: '' };
	const cmd = args.slice(i + 1).join(' ').trim();
	if (!cmd) die('usage: atlas jump [query] --run <command>');
	return { query, cmd };
}

/** Fuzzy-pick a project. Returns an absolute path, an `exec:<shell cmd>` line, or ''. */
async function pickTarget(): Promise<string> {
	const proc = Bun.spawn(['atlas-picker', '--action', 'print', '--output', 'path'], {
		stdin: 'inherit',
		stdout: 'pipe',
		stderr: 'inherit'
	});
	const out = (await new Response(proc.stdout).text()).trim();
	if ((await proc.exited) !== 0) die('atlas-picker failed (installed? `just reinstall` in atlas-picker)');
	return out;
}

/**
 * `atlas jump [query] [--run <cmd…>]` — the whole `pj` flow: resolve a target (best
 * match, or the fuzzy picker without a query) and hand the parent shell the `cd` line,
 * with `--run`'s command chained after it. Also reached via `atlas <query> --run <cmd>`.
 */
export const jump: Command = {
	name: 'jump',
	summary: 'cd to a project (fuzzy picker with no query); --run <cmd> runs it there',
	async run(args) {
		const { query, cmd } = splitRun(args);
		const target = query.length ? (await findProjects(query))[0].path : await pickTarget();
		if (!target) return; // picker cancelled
		// The picker's action selections are already shell command lines.
		const line = target.startsWith('exec:') ? target.slice('exec:'.length) : cdLine(target);
		await shellExec(cmd ? `${line} && ${cmd}` : line);
	}
};

/**
 * `atlas search <query>` — find projects by name/path substring.
 * Also the fallback for `atlas <query>` when <query> isn't a command.
 */
export const search: Command = {
	name: 'search',
	summary: 'find projects by name (also: atlas <query>)',
	async run(args) {
		if (args.some((a) => RUN_FLAGS.includes(a))) return jump.run(args);
		const { query } = splitRun(args);
		const found = await findProjects(query);
		const width = Math.max(...found.map((p) => p.name.length));
		for (const p of found) console.log(`${p.name.padEnd(width)}  ${p.relativePath}`);
	}
};
