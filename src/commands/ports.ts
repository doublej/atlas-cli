import type { Command } from '../types';
import { apiGet } from '../api';
import { requireUp } from '../util';

interface PortSource {
	kind: 'daemon' | 'project';
	label: string;
	name: string;
}

interface PortAudit {
	collisions: { port: number; sources: PortSource[] }[];
	unmanaged: { path: string; relativePath: string; framework: string }[];
}

/** `atlas ports` — retroactive port-collision check across daemons + scanned projects. */
export const ports: Command = {
	name: 'ports',
	summary: 'check for port collisions across daemons and projects',
	async run() {
		await requireUp();
		const audit = await apiGet<PortAudit>('/api/ports/audit');

		if (audit.collisions.length) {
			console.log(`Collisions (${audit.collisions.length}):`);
			for (const { port, sources } of audit.collisions) {
				const names = sources.map((s) => `${s.kind}:${s.label}`).join(', ');
				console.log(`  :${port}  ${names}`);
			}
		} else {
			console.log('No port collisions.');
		}

		if (audit.unmanaged.length) {
			console.log(`\nUnmanaged (port-bearing framework, no declared port) (${audit.unmanaged.length}):`);
			for (const { relativePath, framework } of audit.unmanaged) {
				console.log(`  ${relativePath}  (${framework})`);
			}
		}

		if (audit.collisions.length) process.exitCode = 1;
	}
};
