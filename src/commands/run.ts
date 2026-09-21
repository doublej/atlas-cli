import type { Command } from '../types';
import { apiGet, apiPost } from '../api';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { die, requireUp, resolveRoot } from '../util';
import { projectFor, type InfoProject } from './info';

interface RunResult {
	url: string;
	local?: string;
	remote?: string;
	/** Absent unless the dev server bound loopback only, which no hostname can reach. */
	lanReachable?: boolean;
	/** The spawned process was already gone before it bound anything. */
	exited?: boolean;
	/** Something listens on the port the hostname points at. */
	bound: boolean;
	/** Process groups of a previous run stopped first. */
	replaced: number;
	log: string;
}

/** How long to wait for the dev server to bind — a cold Vite re-optimising deps needs ~30s. */
const WAIT_MS = 60_000;

function logTail(file: string, lines = 15): string {
	try {
		return readFileSync(file, 'utf8').trimEnd().split('\n').slice(-lines).join('\n');
	} catch {
		return '';
	}
}

/** `atlas run [path]` — start the project's dev server via /api/run, print its hostname. */
export const run: Command = {
	name: 'run',
	summary: "start a project's dev server",
	async run(args) {
		const root = resolveRoot(args.find((a) => !a.startsWith('-')));
		await requireUp();
		const { projects } = await apiGet<{ projects: InfoProject[] }>('/api/projects');
		const project = projectFor(projects, root);
		if (!project) die(`No scanned project at ${root}. Run: atlas scan`);
		if (project.path !== root && ['package.json', 'pyproject.toml', '.atlas'].some((f) => existsSync(join(root, f))))
			die(
				`${root} is a project inside ${project.name}, which the scan stops at. Catalog it with a depth entry in ~/dev/.atlas-config.json:\n  "depth": { "${project.relativePath}": ${project.relativePath.split('/').length + 1} }\nthen: atlas scan`
			);
		if (!project.devCommand) die(`${project.name} has no dev command atlas can run.`);

		const result = await apiPost<RunResult>('/api/run', {
			path: project.path,
			command: project.devCommand,
			runner: project.runner ?? 'npm',
			wait: WAIT_MS
		});

		if (result.replaced) console.error(`stopped the previous dev server of ${project.name}`);
		if (result.exited)
			die(`${project.name}'s dev server exited on startup — ${result.log}\n${logTail(result.log)}`);
		if (!result.bound)
			die(
				`${project.name}'s dev server bound nothing in ${WAIT_MS / 1000}s — ${result.log}\n${logTail(result.log)}`
			);

		if (result.lanReachable === false) {
			console.log(result.url);
			console.error(
				"warning: it binds localhost only, so its dev hostname 502s — give the dev server --host 0.0.0.0 (vite: `server.host: true`)."
			);
			return;
		}
		console.log(result.local ?? result.remote ?? result.url);
	}
};
