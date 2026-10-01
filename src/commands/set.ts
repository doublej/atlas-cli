import { parseArgs } from 'node:util';
import type { Command } from '../types';
import { apiGet, apiPatch } from '../api';
import { die, requireUp } from '../util';
import { projectFor, type InfoProject } from './info';

/** The `.atlas` keys something reads: the scanner (atlas-api scanner.ts) plus `agent-log` (this CLI). */
export const ATLAS_KEYS = [
	'slug',
	'port',
	'description',
	'archived',
	'devPublic',
	'type',
	'framework',
	'domain',
	'domains',
	'umami',
	'flow',
	'agent-log'
];
/** Kept as typed even when they would parse as JSON (`slug 2048` stays the string "2048"). */
const STRING_KEYS = new Set(['slug', 'description', 'type', 'framework', 'domain']);

const USAGE = `Usage: atlas set <key> <value> [--json]   write one override into the current project's .atlas
       atlas set --unset <key> [--json]   remove it, so the scanner's detection applies again

Keys: ${ATLAS_KEYS.join(' ')}
A value is JSON when it parses (4100, true, ["a.com"]), else a string; slug, description, type,
framework and domain always stay strings. A slug, port or devPublic change moves the project's dev
hostname — two new ACME certificates each time, so never in a loop.`;

/** Accept loosely, store strictly: numbers, booleans and objects as JSON, everything else as typed. */
export function parseValue(key: string, raw: string): unknown {
	if (STRING_KEYS.has(key)) return raw;
	try {
		return JSON.parse(raw);
	} catch {
		return raw; // not JSON: a plain string
	}
}

/** C.2 `HostnameState`, as far as this prints it. */
interface HostnameState {
	local: string;
	remote: string | null;
	state: string;
	error?: string;
}

/** `atlas set` — PATCH /api/atlas on the project owning cwd; `null` clears a key. */
export const set: Command = {
	name: 'set',
	summary: "set or --unset one .atlas override of the current project (slug, port, …)",
	usage: USAGE,
	async run(args) {
		const { values, positionals } = parseArgs({
			args,
			allowPositionals: true,
			options: { unset: { type: 'string' }, json: { type: 'boolean' } }
		});
		const key = values.unset ?? positionals[0];
		if (!key || (values.unset ? positionals.length > 0 : positionals.length < 2)) die(USAGE);
		if (!ATLAS_KEYS.includes(key)) die(`Unknown .atlas key "${key}". Keys: ${ATLAS_KEYS.join(' ')}`);
		const value = values.unset ? null : parseValue(key, positionals.slice(1).join(' '));

		await requireUp();
		const { projects } = await apiGet<{ projects: InfoProject[] }>('/api/projects');
		const project = projectFor(projects, process.cwd());
		if (!project) die(`No scanned project at ${process.cwd()}. Run: atlas scan`);
		const res = await apiPatch<{ hostname?: HostnameState }>('/api/atlas', {
			path: project.path,
			patch: { [key]: value }
		});
		if (values.json) return console.log(JSON.stringify(res));

		const shown = value === null ? 'cleared' : `= ${typeof value === 'string' ? value : JSON.stringify(value)}`;
		console.log(`${key} ${shown}  (${project.relativePath}/.atlas)`);
		const h = res.hostname;
		if (h) console.log(`hostname ${h.local}  (${h.state}${h.error ? ` — ${h.error}` : ''})`);
	}
};
