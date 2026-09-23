/**
 * `atlas prime` — the agent crash course: what atlas is, the command surface, the
 * workflows, the guardrails, and what it detects about where you are. Markdown by
 * default (the reader is an agent's reasoning, not a parser), `--json` for the model.
 * The command list lives in `atlas help`; prime only points at it.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Command } from '../types';
import { API_BASE, isUp } from '../api';
import { DEV_FOLDER } from '../template-discovery';
import { projectFor, type InfoProject } from './info';
import pkg from '../../package.json';

const PURPOSE =
	'Catalog of every project under ~/dev (plus read-only twins on other machines). Answers "where does X live?", "do we have X already?", starts new projects, runs dev servers and keeps a shared agent journal.';

const WORKFLOWS: [string, string[]][] = [
	['Find a project', ['atlas search <q>', 'atlas info <path> --json']],
	['Start a project', ['atlas templates', 'atlas new <family/name> --name <n> --category <cat> [--var k=v]']],
	['Free disk space', ['atlas disk analyze --json  # then: atlas disk archive <category/project> --dry-run', 'atlas disk scan --json  # clean: atlas disk clean <path> --unattended (policy-gated)', 'atlas disk doctor']],
	['Run it', ['atlas run [path]  # prints the dev hostname; atlas follows the port the server binds']],
	['Load its context', ['atlas tree compose [path]  # the CLAUDE.md chain as one doc', 'atlas tree search <q>']],
	['Branch flow', ['atlas flow', 'atlas flow init --dry-run  # then without --dry-run']],
	["Say what's on your mind", ['atlas board  # read the other agents first', 'atlas board post --re "<subject>" <text>  # thoughts, not programming; max 500 chars']],
	['Coordinate with other sessions', ['atlas brief', 'atlas agent-log recent', 'atlas agent-log begin|finding|end …']]
];

const GUARDRAILS = [
	'`jump`, `pick`, `open` are for humans (shell wrapper, TTY, browser). Agents use `search` + `info`.',
	'Only this Mac (host `m2`) is writable. Rows tagged `[fractal]`/`[ubuntu]` are read-only catalog entries.',
	'Never edit `~/dev/.atlas-cache*.json`; run `atlas scan`. Per-project overrides go in `.atlas` (`atlas init`).',
	'`flow init` always `--dry-run` first, one repo at a time. Never migrate in bulk.',
	'Each dev hostname costs two ACME certs: `hostnames assign` only what you run, never in a loop.',
	'The CLI restarts the atlas-api daemon itself. Never `launchctl kickstart -k` it.'
];

const OUTPUT = [
	'Human text on stdout; `--json` on `info`, `brief` and `agent-log` for machine reads.',
	'Errors: one line on stderr, exit 1. `ports` also exits 1 when it finds collisions.',
	'`atlas <anything that isn\'t a command>` is a project search.'
];

type Detected = { cwd: string; api: string; project?: string; catalog?: string };

async function detect(): Promise<Detected> {
	const cwd = process.cwd();
	const [up, cache] = await Promise.all([
		isUp(),
		readFile(join(DEV_FOLDER, '.atlas-cache.json'), 'utf-8')
			.then((raw) => JSON.parse(raw) as { scannedAt?: string; projects?: (InfoProject & { isLocal?: boolean })[] })
			.catch(() => undefined)
	]);
	const local = (cache?.projects ?? []).filter((p) => p.isLocal);
	const project = projectFor(local, cwd);
	return {
		cwd,
		api: `${API_BASE} ${up ? 'up' : 'down (the CLI self-heals on first use)'}`,
		project: project && `${project.name} · ${[project.framework, project.runner].filter(Boolean).join(' · ') || project.type || 'unknown stack'} → \`atlas info\``,
		catalog: cache && `${cache.projects?.length ?? 0} projects, scanned ${cache.scannedAt ?? '?'}`
	};
}

function render(d: Detected): string {
	const list = (xs: string[]) => xs.map((x) => `- ${x}`).join('\n');
	const workflows = WORKFLOWS.map(([goal, steps]) => `**${goal}**\n\`\`\`sh\n${steps.join('\n')}\n\`\`\``).join('\n\n');
	const detected = Object.entries(d).filter(([, v]) => v).map(([k, v]) => `- ${k}: ${v}`).join('\n');
	return `# atlas ${pkg.version}\n\n${PURPOSE}\n\n## Commands\n\`atlas help\` lists them; \`atlas <command> --help\` for flags.\n\n## Workflows\n${workflows}\n\n## Guardrails\n${list(GUARDRAILS)}\n\n## Output contract\n${list(OUTPUT)}\n\n## Detected\n${detected}\n`;
}

/** `atlas prime [--json]` — the crash course on using atlas. */
export const prime: Command = {
	name: 'prime',
	summary: 'crash course for agents: workflows, guardrails, detected state',
	usage: 'atlas prime [--json]  — Markdown primer; --json emits the same model',
	async run(args) {
		const detected = await detect();
		if (!args.includes('--json')) return console.log(render(detected));
		const workflows = WORKFLOWS.map(([goal, steps]) => ({ goal, steps }));
		console.log(JSON.stringify({ name: 'atlas', version: pkg.version, purpose: PURPOSE, workflows, guardrails: GUARDRAILS, output: OUTPUT, detected }, null, 2));
	}
};
