import type { Command } from '../types';
import { apiDelete, apiGet } from '../api';
import { die, requireUp, resolveRoot } from '../util';
import { projectFor, type InfoProject } from './info';

/** `atlas stop [path]` — stop the dev server `atlas run` started, via DELETE /api/run. */
export const stop: Command = {
	name: 'stop',
	summary: "stop a project's dev server (the counterpart of `run`)",
	usage: 'Usage: atlas stop [path] [--json]   stop the dev server of the project at path (default: cwd)',
	async run(args) {
		const json = args.includes('--json');
		const root = resolveRoot(args.find((a) => !a.startsWith('-')));
		await requireUp();
		const { projects } = await apiGet<{ projects: InfoProject[] }>('/api/projects');
		const project = projectFor(projects, root);
		if (!project) die(`No scanned project at ${root}. Run: atlas scan`);
		const { stopped } = await apiDelete<{ stopped: boolean }>('/api/run', { path: project.path });
		if (json) return console.log(JSON.stringify({ name: project.name, path: project.path, stopped }));
		console.log(stopped ? `stopped ${project.name}` : `${project.name} wasn't running`);
	}
};
