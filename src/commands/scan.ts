import type { Command } from '../types';
import { apiPost } from '../api';
import { requireUp } from '../util';

type Atlas = { projects: unknown[]; frameworks: string[] };

/** `atlas scan` — force a rescan of the development catalog. */
export const scan: Command = {
	name: 'scan',
	summary: 'force a rescan of the development catalog',
	async run(args) {
		await requireUp();
		const atlas = await apiPost<Atlas>('/api/refresh');
		if (args.includes('--json'))
			return console.log(JSON.stringify({ projects: atlas.projects.length, frameworks: atlas.frameworks.length }));
		console.log(`Rescanned — ${atlas.projects.length} projects, ${atlas.frameworks.length} frameworks`);
	}
};
