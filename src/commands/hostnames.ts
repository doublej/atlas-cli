import type { Command } from '../types';
import { apiDelete, apiGet, apiPost } from '../api';
import { die, requireUp, resolveRoot } from '../util';
import { projectFor, type InfoProject } from './info';
import { doctor } from './hostnames-doctor';

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

/** C.2 `GET /api/hostnames/check`: always 200, `status` carries the verdict. */
export interface CheckResult {
	slug: string;
	status: 'free' | 'current' | 'taken' | 'invalid';
	reason?: string;
	holder?: { kind: 'project' | 'service'; name: string; path?: string };
	local: string;
	remote: string | null;
}

export function verdict(r: CheckResult): string {
	if (r.status === 'taken' && r.holder)
		return `taken by ${r.holder.kind} ${r.holder.name}${r.holder.path ? ` (${r.holder.path})` : ''}`;
	if (r.status === 'invalid') return `invalid: ${r.reason ?? 'not a DNS label'}`;
	return r.status;
}

const print = (json: boolean, data: unknown, text: string): void => console.log(json ? JSON.stringify(data) : text);

async function list(json: boolean): Promise<void> {
	const entries = await apiGet<HostnameEntry[]>('/api/hostnames');
	if (json) return console.log(JSON.stringify(entries));
	if (!entries.length) return console.log('No dev hostnames registered.');
	for (const e of entries) console.log(`${e.slug.padEnd(24)} ${e.local ?? e.remote ?? '—'}`);
}

async function assign(root: string, json: boolean): Promise<void> {
	const result = await apiPost<AssignResult>('/api/hostnames', { path: root });
	if (json) return console.log(JSON.stringify(result));
	if (!result.nasSynced) return console.log(`Port reserved (${result.port}) — NAS push failed, not synced.`);
	console.log(result.local ?? result.remote ?? `port ${result.port}`);
}

/** Exit 0 only when the slug is free, or already this project's. */
async function check(slug: string, pathArg: string | undefined, json: boolean): Promise<void> {
	const { projects } = await apiGet<{ projects: InfoProject[] }>('/api/projects');
	const path = projectFor(projects, resolveRoot(pathArg))?.path;
	const query = new URLSearchParams({ slug, ...(path ? { path } : {}) });
	const result = await apiGet<CheckResult>(`/api/hostnames/check?${query}`);
	print(json, result, verdict(result));
	if (result.status !== 'free' && result.status !== 'current') process.exitCode = 1;
}

const USAGE = `Usage: atlas hostnames [list] [--json]
       atlas hostnames assign [path] [--json]    route the project's dev hostname (two ACME certificates)
       atlas hostnames rm [path] [--json]
       atlas hostnames check <slug> [path] [--json]   free · current · taken by … · invalid: … (exit 1 unless free/current)
       atlas hostnames doctor [--fix] [--json]   drift between rows, .atlas, Caddy and the NAS (exit 1 while any remains)`;

/** `atlas hostnames` — assign, check or remove a dev hostname without spawning a dev server. */
export const hostnames: Command = {
	name: 'hostnames',
	summary: 'dev hostnames: list, `assign`/`rm [path]`, `check <slug>`, `doctor [--fix]`',
	usage: USAGE,
	async run(args) {
		const json = args.includes('--json');
		const [sub, arg, pathArg] = args.filter((a) => !a.startsWith('-'));
		if (sub === 'check' && !arg) die(USAGE);
		if (sub && !['list', 'assign', 'rm', 'check', 'doctor'].includes(sub)) die(USAGE);
		await requireUp();

		if (!sub || sub === 'list') return list(json);
		if (sub === 'assign') return assign(resolveRoot(arg), json);
		if (sub === 'check') return check(arg, pathArg, json);
		if (sub === 'doctor') return doctor(args.includes('--fix'), json);
		print(json, await apiDelete('/api/hostnames', { path: resolveRoot(arg) }), 'removed');
	}
};
