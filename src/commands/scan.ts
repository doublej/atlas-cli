import type { Command } from '../types';
import { apiPost } from '../api';
import { requireUp } from '../util';

type Atlas = { projects: unknown[]; frameworks: string[] };

/** `atlas scan` — force a rescan of the development catalog. */
export const scan: Command = {
	name: 'scan',
	summary: 'force a rescan of the development catalog',
	async run() {
		await requireUp();
		const atlas = await apiPost<Atlas>('/api/refresh');
		console.log(`Rescanned — ${atlas.projects.length} projects, ${atlas.frameworks.length} frameworks`);
	}
};
