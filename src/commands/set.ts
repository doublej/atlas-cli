import { parseArgs } from 'node:util';
import type { Command } from '../types';
import { apiGet, apiPatch, apiPut } from '../api';
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

const USAGE = `Usage: atlas set <key> <value> [--json]   write one override into the current project's .atlas
       atlas set --unset <key> [--json]   remove it, so the scanner's detection applies again

Keys: ${ATLAS_KEYS.join(' ')}
Values: port 4100 · archived, devPublic true|false · domains a.com b.com (or a JSON array) ·
umami a website id (or JSON) · flow, agent-log a JSON object · slug, description, type, framework,
domain plain text (\`slug 2048\` stays "2048"). Anything else is exit 1 before any write.
description is the exception: it goes to ~/dev/.atlas-descriptions.json, which beats .atlas.
A slug, port or devPublic change moves the project's dev hostname and reloads the shared NAS Caddy
(the wildcard certificate covers it), so never in a loop.`;

const json = (raw: string): unknown => {
	try {
		return JSON.parse(raw);
	} catch {
		return undefined; // not JSON
	}
};
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');
const is =
	(test: (v: unknown) => boolean) =>
	(raw: string): unknown => {
		const v = json(raw);
		return test(v) ? v : undefined;
	};
const bool = is((v) => typeof v === 'boolean');

/** The non-string keys: what each takes (for the error), and raw → the value the scanner reads. */
const TYPED: Record<string, [string, (raw: string) => unknown]> = {
	port: ['an integer port 1024–65535', is((v) => Number.isInteger(v) && (v as number) >= 1024 && (v as number) <= 65535)],
	archived: ['true or false', bool],
	devPublic: ['true or false', bool],
	domains: ['domain names (a.com b.com) or a JSON string array', (raw) => {
		const v = json(raw) ?? raw;
		return typeof v === 'string' ? v.split(/[\s,]+/).filter(Boolean) : isStrings(v) ? v : undefined;
	}],
	umami: ['a website id, a JSON array of ids or {"websiteIds": […], "instance": "…"}', (raw) => {
		const v = json(raw) ?? raw;
		return typeof v === 'string' || isStrings(v) || (isObject(v) && isStrings(v.websiteIds)) ? v : undefined;
	}],
	flow: ['a JSON object, e.g. {"trunk": "main", "integration": "develop"}', is(isObject)],
	'agent-log': ['a JSON object, e.g. {"mode": "warn"}', is(isObject)]
};

/** Accept loosely, store strictly: raw → the value the scanner reads, undefined when it isn't one. */
export function parseValue(key: string, raw: string): unknown {
	return TYPED[key] ? TYPED[key][1](raw) : raw.trim() ? raw : undefined;
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
		const raw = positionals.slice(1).join(' ');
		const value = values.unset ? null : parseValue(key, raw);
		if (value === undefined) die(`${key} takes ${TYPED[key]?.[0] ?? 'a non-empty string'}, not ${JSON.stringify(raw)}`);

		await requireUp();
		const { projects } = await apiGet<{ projects: InfoProject[] }>('/api/projects');
		const project = projectFor(projects, process.cwd());
		if (!project) die(`No scanned project at ${process.cwd()}. Run: atlas scan`);
		if (key === 'description') {
			// The central file beats .atlas, so a .atlas description would be shadowed by any entry there.
			await apiPut('/api/description', { path: project.path, description: value ?? '' });
			if (values.json) return console.log(JSON.stringify({ updated: true }));
			return console.log(`description ${value === null ? 'cleared' : `= ${value}`}  (~/dev/.atlas-descriptions.json)`);
		}
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
