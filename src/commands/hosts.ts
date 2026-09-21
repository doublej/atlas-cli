import { join } from 'node:path';
import type { Command } from '../types';
import { apiGet, apiPost } from '../api';
import { expandHome, getHostById, getHosts, getRemoteHosts, type HostDef } from '../../../shared/hosts';
import { DEV_FOLDER } from '../template-discovery';
import { die, requireUp } from '../util';

/** Per-host outcome of the last scan, as `/api/projects` reports it. */
interface HostState {
	id: string;
	root: string;
	scannedAt: string;
	status: 'ok' | 'unreachable' | 'error';
	error?: string;
	projectCount: number;
}

const repoRoot = (): string =>
	process.env.ATLAS_REPO ?? join(DEV_FOLDER, 'multi-stack', 'project-atlas');

const agentBundle = (): string => join(repoRoot(), 'shared', 'agent', 'atlas-scan.mjs');

async function sh(cmd: string[], cwd?: string): Promise<{ ok: boolean; err: string }> {
	const proc = Bun.spawn(cmd, { cwd, stdout: 'pipe', stderr: 'pipe' });
	const err = await new Response(proc.stderr).text();
	return { ok: (await proc.exited) === 0, err: err.trim() };
}

/** Rebuild the scan agent from atlas-api's scanner — always, so the hosts can't run a stale copy. */
async function buildAgent(): Promise<void> {
	const { ok, err } = await sh(['bun', 'run', 'agent:build'], join(repoRoot(), 'atlas-api'));
	if (!ok) die(`agent:build failed:\n${err}`);
}

/**
 * Ship the agent to one host. scp cannot create the destination directory, and a Windows path
 * containing spaces is unquotable through scp — hence the explicit mkdir and the forward-slash,
 * space-free `agent` paths in `hosts.json`.
 */
async function syncOne(host: HostDef): Promise<boolean> {
	if (!host.ssh || !host.agent) return false;
	const dir = host.agent.slice(0, host.agent.lastIndexOf('/'));
	const mkdir =
		host.os === 'win32' ? `New-Item -ItemType Directory -Force -Path ${dir}` : `mkdir -p ${dir}`;

	const opts = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=4'];
	const made = await sh(['ssh', ...opts, host.ssh, mkdir]);
	if (!made.ok) {
		console.log(`  ${host.id.padEnd(8)} mkdir failed — ${made.err.split('\n').pop()}`);
		return false;
	}
	const copied = await sh(['scp', '-q', agentBundle(), `${host.ssh}:${host.agent}`]);
	console.log(
		copied.ok
			? `  ${host.id.padEnd(8)} → ${host.agent}`
			: `  ${host.id.padEnd(8)} scp failed — ${copied.err.split('\n').pop()}`
	);
	return copied.ok;
}

async function listHosts(): Promise<void> {
	await requireUp();
	const { hosts: states } = await apiGet<{ hosts?: HostState[] }>('/api/projects');
	const byId = new Map((states ?? []).map((s) => [s.id, s]));

	for (const h of getHosts()) {
		const s = byId.get(h.id);
		const where = h.ssh ? `ssh:${h.ssh}` : 'local';
		const count = s ? `${s.projectCount} projects` : 'never scanned';
		const state = s?.status === 'ok' ? '' : `  ⚠ ${s?.status ?? 'no data'}${s?.error ? ` — ${s.error}` : ''}`;
		const root = expandHome(h.root); // the primary's root is stored as `~/…`
		console.log(`${h.id.padEnd(8)} ${h.role.padEnd(9)} ${where.padEnd(14)} ${root.padEnd(34)} ${count}${state}`);
	}
}

export const hosts: Command = {
	name: 'hosts',
	summary: 'list catalogued machines; `sync` ships the scan agent, `scan` refreshes one',
	async run(args) {
		const [sub, id] = args;

		if (!sub || sub === 'list') return listHosts();

		if (sub === 'sync') {
			const targets = id
				? [getHostById(id)].filter((h): h is HostDef => Boolean(h?.ssh))
				: getRemoteHosts();
			if (targets.length === 0) die(`No remote host "${id}". Known: ${getRemoteHosts().map((h) => h.id).join(', ')}`);
			await buildAgent();
			console.log(`Built ${agentBundle()}`);
			for (const h of targets) await syncOne(h);
			return;
		}

		if (sub === 'scan') {
			await requireUp();
			const query = id ? `?host=${encodeURIComponent(id)}&force=true` : '?force=true';
			await apiPost(`/api/refresh${query}`);
			return listHosts();
		}

		die('Usage: atlas hosts [list | sync [host] | scan [host]]');
	}
};
