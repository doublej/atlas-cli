import type { Command } from '../types';
import { apiGet, isUp } from '../api';
import { die } from '../util';

interface TemplateVar {
	name: string;
	default?: unknown;
	isChoice?: boolean;
	choices?: unknown[];
	isDerived?: boolean;
	references?: string[];
}

interface Template {
	family: string;
	name: string;
	description?: string;
	version?: string;
	path: string;
	variables: TemplateVar[];
}

interface TemplateError {
	path: string;
	message: string;
}

interface LintEntry {
	level: 'error' | 'warn' | 'info';
	code: string;
	template?: string;
	message: string;
}

interface TemplatesResponse {
	templates: Template[];
	errors?: TemplateError[];
	lint?: LintEntry[];
}

const OFFLINE_MSG = `atlas-api isn't running — can't reach /api/templates.\nRestart it: launchctl kickstart -k gui/$(id -u)/com.jurrejan.atlas-api`;

async function fetchTemplates(): Promise<TemplatesResponse> {
	if (!(await isUp())) die(OFFLINE_MSG);
	try {
		return await apiGet<TemplatesResponse>('/api/templates');
	} catch (e) {
		die(`GET /api/templates failed: ${(e as Error).message}`);
	}
}

function statusFor(t: Template, lint: LintEntry[], errors: TemplateError[]): 'ok' | 'warns' | 'error' {
	const key = `${t.family}/${t.name}`;
	if (errors.some((e) => e.path.includes(t.path))) return 'error';
	const own = lint.filter((l) => l.template === key || l.template === t.path);
	if (own.some((l) => l.level === 'error')) return 'error';
	if (own.some((l) => l.level === 'warn')) return 'warns';
	return 'ok';
}

async function list(): Promise<void> {
	const { templates, errors = [], lint = [] } = await fetchTemplates();
	if (!templates.length) return void console.log('No templates found.');

	const rows = templates.map((t) => ({
		family: t.family,
		name: t.name,
		version: t.version ?? '-',
		vars: String(t.variables.length),
		status: statusFor(t, lint, errors)
	}));
	const widths = {
		family: Math.max(6, ...rows.map((r) => r.family.length)),
		name: Math.max(4, ...rows.map((r) => r.name.length)),
		version: Math.max(7, ...rows.map((r) => r.version.length)),
		vars: Math.max(4, ...rows.map((r) => r.vars.length))
	};
	console.log(
		`${'FAMILY'.padEnd(widths.family)}  ${'NAME'.padEnd(widths.name)}  ${'VERSION'.padEnd(widths.version)}  ${'VARS'.padEnd(widths.vars)}  STATUS`
	);
	for (const r of rows) {
		console.log(
			`${r.family.padEnd(widths.family)}  ${r.name.padEnd(widths.name)}  ${r.version.padEnd(widths.version)}  ${r.vars.padEnd(widths.vars)}  ${r.status}`
		);
	}
	if (errors.length) console.log(`\n${errors.length} template(s) failed to parse — see \`atlas templates lint\`.`);
}

async function lint(): Promise<void> {
	const { errors = [], lint: entries = [] } = await fetchTemplates();

	if (errors.length) {
		console.log(`Parse errors (${errors.length}):`);
		for (const e of errors) console.log(`  ${e.path}: ${e.message}`);
	}

	for (const level of ['error', 'warn', 'info'] as const) {
		const group = entries.filter((l) => l.level === level);
		if (!group.length) continue;
		console.log(`\n${level.toUpperCase()} (${group.length}):`);
		for (const l of group) console.log(`  ${l.template ? `${l.template}: ` : ''}${l.code} — ${l.message}`);
	}

	if (!errors.length && !entries.length) console.log('No lint findings.');

	if (errors.length || entries.some((l) => l.level === 'error')) process.exitCode = 1;
}

export const templates: Command = {
	name: 'templates',
	summary: 'list cookiecutter templates and lint findings',
	async run(args) {
		const [sub] = args;
		if (sub === 'lint') await lint();
		else if (!sub || sub === 'list') await list();
		else die(`Unknown subcommand '${sub}'. Usage: atlas templates [list|lint]`);
	}
};
