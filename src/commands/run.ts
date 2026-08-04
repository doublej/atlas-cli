import type { Command } from '../types';

/**
 * `atlas run` — start/stop a project's dev server via /api/run. Planned.
 * Slot is wired so the dispatch + help already list it; fill in once the
 * cwd→project→runner resolution is settled.
 */
export const run: Command = {
	name: 'run',
	summary: 'start/stop a project dev server (planned)',
	async run() {
		console.log("`atlas run` is planned — for now use `atlas open` (UI) or the project's `just dev`.");
	}
};
