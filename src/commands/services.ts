import type { Command } from '../types';
import { apiGet, apiPost } from '../api';
import { die, requireUp } from '../util';

interface ServiceState {
	slug: string;
	name: string;
	port: number;
	mode: 'direct' | 'bridge' | 'down';
	local: string | null;
	error?: string;
}

function print(services: ServiceState[]): void {
	if (!services.length) return console.log('Not synced yet — run `atlas services sync`.');
	for (const s of services) {
		const where = s.error ?? s.local ?? '—';
		console.log(`${s.slug.padEnd(12)} :${String(s.port).padEnd(6)} ${s.mode.padEnd(7)} ${where}`);
	}
}

/** `atlas services` — the permanent local web UIs from `shared/services.json` and their hostnames. */
export const services: Command = {
	name: 'services',
	summary: 'service hostnames: list, `sync` to route them now',
	usage: 'Usage: atlas services [list | sync]',
	async run(args) {
		const [sub] = args;
		await requireUp();
		if (!sub || sub === 'list') return print((await apiGet<{ services: ServiceState[] }>('/api/services')).services);
		if (sub === 'sync') return print((await apiPost<{ services: ServiceState[] }>('/api/services')).services);
		die(services.usage!);
	}
};
