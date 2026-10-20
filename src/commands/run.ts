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
	/** Absent unless the dev server bound loopback only; atlas then bridges it for the NAS. */
	lanReachable?: boolean;
	/** The spawned process was already gone before it bound anything. */
	exited?: boolean;
	/** The dev server bound another port than the pinned one; `.atlas` now pins `to`. */
	portMoved?: { from: number; to: number };
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

const USAGE = `Usage: atlas run [path] [--json]
  Starts the project's dev command and prints its dev hostname.
  npm/bun/yarn/pnpm scripts get --port <port> --host 0.0.0.0 appended (unless the script sets
  them, or fans out via concurrently/turbo). A command that rejects those flags, e.g.
  python3 -m http.server, exits on startup: give it a wrapper that takes them, or start it yourself.
  When the server binds another port than the pinned one it prints "port moved N -> M"
  (--json: portMoved {from, to}) and .atlas pins the new port.`;

const FLAGS_HINT = 'atlas appends --port/--host to the dev script; if the log shows them rejected, that is the cause (atlas run --help).';

/** `atlas run [path]` — start the project's dev server via /api/run, print its hostname. */
export const run: Command = {
	name: 'run',
	summary: "start a project's dev server",
	usage: USAGE,
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
		if (args.includes('--json')) {
			console.log(JSON.stringify(result));
			if (result.exited || !result.bound) process.exitCode = 1;
			return;
		}
		if (result.exited)
			die(`${project.name}'s dev server exited on startup — ${result.log}\n${logTail(result.log)}${project.runner === 'uv' ? '' : `\n${FLAGS_HINT}`}`);
		if (!result.bound)
			die(
				`${project.name}'s dev server bound nothing in ${WAIT_MS / 1000}s — ${result.log}\n${logTail(result.log)}`
			);

		// A loopback-only server is routed through atlas's NAS-only bridge, so its hostname works;
		// the note says why it sits behind a forwarder.
		if (result.lanReachable === false)
			console.error("note: it binds localhost only — its dev hostname goes through atlas's bridge.");
		if (result.portMoved) console.log(`port moved ${result.portMoved.from} -> ${result.portMoved.to}`);
		console.log(result.local ?? result.remote ?? result.url);
	}
};
