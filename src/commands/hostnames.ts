import type { Command } from '../types';
import { apiDelete, apiGet, apiPost } from '../api';
import { die, requireUp, resolveRoot } from '../util';

interface HostnameEntry {
	slug: string;
	path: string;
	local?: string;
	remote?: string;
}

interface AssignResult {
	slug: string;
	port: number;
	nasSynced: boolean;
	local?: string;
	remote?: string;
}

async function list(): Promise<void> {
	await requireUp();
	const entries = await apiGet<HostnameEntry[]>('/api/hostnames');
	if (!entries.length) return console.log('No dev hostnames registered.');
	for (const e of entries) console.log(`${e.slug.padEnd(24)} ${e.local ?? e.remote ?? '—'}`);
}

async function assign(root: string): Promise<void> {
	await requireUp();
	const result = await apiPost<AssignResult>('/api/hostnames', { path: root });
	if (!result.nasSynced) return console.log(`Port reserved (${result.port}) — NAS push failed, not synced.`);
	console.log(result.local ?? result.remote ?? `port ${result.port}`);
}

async function rm(root: string): Promise<void> {
	await requireUp();
	await apiDelete('/api/hostnames', { path: root });
	console.log('removed');
}

/** `atlas hostnames` — assign or remove a dev hostname without spawning a dev server. */
export const hostnames: Command = {
	name: 'hostnames',
	summary: 'dev hostnames: list, `assign [path]`, `rm [path]`',
	usage: 'Usage: atlas hostnames [list | assign [path] | rm [path]]',
	async run(args) {
		const [sub, pathArg] = args;

		if (!sub || sub === 'list') return list();
		if (sub === 'assign') return assign(resolveRoot(pathArg));
		if (sub === 'rm') return rm(resolveRoot(pathArg));

		die(hostnames.usage!);
	}
};
