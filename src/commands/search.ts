import type { Command } from '../types';
import { apiGet } from '../api';
import { findFolder, type Project, rank, rankProjects } from '../ranking';
import { cdLine, die, requireUp, shellExec } from '../util';

type Atlas = { baseDir: string; projects: Project[]; folders: string[] };

const normalize = (args: string[]): string => {
	const query = args.join(' ').trim().toLowerCase();
	if (!query) die('Usage: atlas search <query>');
	return query;
};

/** All projects matching the query, best match first. Dies when nothing matches. */
async function findProjects(args: string[]): Promise<Project[]> {
	const query = normalize(args);
	await requireUp();
	const { projects } = await apiGet<Atlas>('/api/projects');
	const found = rankProjects(projects, query);
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
 * Where `atlas jump <query>` lands: an exactly-named folder when no project carries the name
 * itself, else the best-ranked project — and never a path that lives on another machine.
 */
async function resolveTarget(query: string[]): Promise<string> {
	const q = normalize(query);
	await requireUp();
	const atlas = await apiGet<Atlas>('/api/projects');
	const found = rankProjects(atlas.projects, q);
	const best = found[0];

	// A project named exactly (or nearly) the query wins; otherwise the folder of that name is
	// the workspace you meant, and folders are only ever collected on this machine.
	if (!best || rank(best, q) > 1) {
		const folder = findFolder(atlas.folders ?? [], atlas.projects, q);
		if (folder) return `${atlas.baseDir}/${folder}`;
	}
	if (!best) die(`No projects matching "${q}". Run \`atlas help\` for commands.`);

	// A remote project's path exists on Fractal/Ubuntu, not here: cd-ing to it would
	// drop the shell somewhere that does not exist. Refuse rather than half-work.
	if (best.isLocal === false || (best.host && best.isLocal === undefined)) {
		die(`"${best.name}" lives on ${best.host ?? 'another host'} (${best.path}) — atlas jump only moves within this machine.`);
	}
	return best.path;
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
		let target: string;
		if (query.length) {
			target = await resolveTarget(query);
		} else {
			target = await pickTarget();
		}
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
		for (const p of found) {
			const where = p.isLocal ? '' : `  [${p.host ?? 'remote'}]`;
			console.log(`${p.name.padEnd(width)}  ${p.relativePath}${where}`);
		}
	}
};
