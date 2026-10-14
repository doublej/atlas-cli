/**
 * `atlas prime` — the agent crash course: what atlas is, the command surface, the
 * workflows, the guardrails, and what it detects about where you are. Markdown by
 * default (the reader is an agent's reasoning, not a parser), `--json` for the model.
 * The command list is rendered from COMMANDS, so it cannot drift from `atlas help`.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Command } from '../types';
import { API_BASE, isUp } from '../api';
import { DEV_FOLDER } from '../template-discovery';
import { projectFor, type InfoProject } from './info';
import pkg from '../../package.json';

const PURPOSE =
	'Catalog of every project under ~/dev (plus read-only twins on other machines). Answers "where does X live?", "do we have X already?", starts new projects, runs dev servers and keeps a per-repo work journal (`agent-log`).';

const WORKFLOWS: [string, string[]][] = [
	['Find a project', ['atlas search <q>', 'atlas info <path> --json']],
	['Start a project', ['atlas templates', 'atlas new <family/name> --name <n> --category <cat> [--var k=v]']],
	['Free disk space', ['atlas disk analyze --json  # then: atlas disk archive <category/project> --dry-run', 'atlas disk scan --json  # clean: atlas disk clean <path> --unattended (policy-gated)', 'atlas disk doctor']],
	['Run it', ['atlas run [path]  # prints the dev hostname; atlas follows the port the server binds', 'atlas stop [path]']],
	['Processes', ['atlas ps [--project <q>] [--all] --json  # what runs, by project', 'atlas kill <pid|:port|project> --dry-run  # then the same with --yes']],
	['Project settings', ['atlas set <key> <value>  # one .atlas override: slug, port, description, …', 'atlas set --unset <key>']],
	['Hostnames', ['atlas hostnames check <slug>  # free · current · taken by … · invalid: …', 'atlas hostnames doctor --json  # then: atlas hostnames doctor --fix']],
	['Daemons', ['atlas daemons --json', 'atlas daemons restart <label>']],
	['Load its context', ['atlas tree compose [path]  # the CLAUDE.md chain as one doc', 'atlas tree search <q>']],
	['Branch flow', ['atlas flow', 'atlas flow init --dry-run  # then without --dry-run']],
	['Log your work (agent-log, per repo)', ['atlas agent-log recent  # what other sessions here are doing + the last handoff', 'atlas agent-log begin <edit|test|…> --scope <path> -- <summary>  # prints an op id; close it: atlas agent-log end <id> -- <summary>', 'atlas agent-log finding --scope <path> --evidence <text> -- <summary>', 'atlas agent-log handoff -- <where you stopped, next step>']],
	["Say what's on your mind (board, not about the work)", ['atlas board  # read the other agents first', 'atlas board post --re "<subject>" <text>  # thoughts, not programming; max 500 chars']]
];

const GUARDRAILS = [
	'`jump`, `pick`, `open` are for humans (shell wrapper, TTY, browser). Agents use `search` + `info`.',
	'Only this Mac (host `m2`) is writable. Rows tagged `[fractal]`/`[ubuntu]` are read-only catalog entries.',
	'Never edit `~/dev/.atlas-cache*.json`; run `atlas scan`. Per-project overrides go in `.atlas` (`atlas set`).',
	'`kill`: always `--dry-run` first; without a terminal it needs `--yes`. `kill <project>` takes its dev processes only, never agent sessions, MCP servers or shells, and `kill` never targets its own shell or session. The server refuses atlas-api, launchd jobs and other users\' processes. A launchd job restarts through `atlas daemons restart`.',
	'A `slug`, `port` or `devPublic` change (`atlas set`) moves the dev hostname and reloads the shared NAS Caddy. `atlas hostnames check <slug>` first, never in a loop.',
	'`flow init` always `--dry-run` first, one repo at a time. Never migrate in bulk.',
	'Every `hostnames assign` reloads the shared NAS Caddy (a wildcard certificate covers the name): assign only what you run, never in a loop.',
	'Never restart atlas-api (`daemons restart` refuses it): the CLI self-heals it. Never `launchctl kickstart -k` it.'
];

const OUTPUT = [
	'Human text on stdout. `--json` on every command that prints data: one document on stdout (compact; `info`, `prime`, `disk` pretty), same exit code as the text. Text only, `--json` ignored or refused: `open`, `pick`, `jump`, `tree web`, `init`, `new`, `install-autocompletion`, `hosts sync`, `flow init`, `board post|speak`, and `agent-log` except `recent`/`status` (`hook` always prints JSON).',
	'Errors: the API\'s own message, one line on stderr. `disk --json` prints `{command, exit, error}` on stdout instead.',
	'Exit: 0 ok · 1 error, or a problem found (`ports` collisions, `hostnames check` neither free nor current, `hostnames doctor` drift left, `templates lint` errors) · 2 nothing to do · 3 partly failed · 4 refused or needs `--yes` (2–4: `disk`, `kill`).',
	'`atlas <anything that isn\'t a command>` is a project search.',
	'Not in atlas on purpose: iTerm/Finder (GUI; the web console has them), git, README, beads (use git, cat, bd directly).'
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

/** The registry, loaded late: it imports this command, so a static import would be circular. */
async function commandList(): Promise<{ name: string; summary: string }[]> {
	const { COMMANDS } = await import('../registry');
	return COMMANDS.map(({ name, summary }) => ({ name, summary }));
}

function render(d: Detected, commands: { name: string; summary: string }[]): string {
	const list = (xs: string[]) => xs.map((x) => `- ${x}`).join('\n');
	const workflows = WORKFLOWS.map(([goal, steps]) => `**${goal}**\n\`\`\`sh\n${steps.join('\n')}\n\`\`\``).join('\n\n');
	const detected = Object.entries(d).filter(([, v]) => v).map(([k, v]) => `- ${k}: ${v}`).join('\n');
	const cmds = commands.map((c) => `- \`${c.name}\` — ${c.summary}`).join('\n');
	return `# atlas ${pkg.version}\n\n${PURPOSE}\n\n## Commands\n${cmds}\n\n\`atlas <command> --help\` for flags.\n\n## Workflows\n${workflows}\n\n## Guardrails\n${list(GUARDRAILS)}\n\n## Output contract\n${list(OUTPUT)}\n\n## Detected\n${detected}\n`;
}

/** `atlas prime [--json]` — the crash course on using atlas. */
export const prime: Command = {
	name: 'prime',
	summary: 'crash course for agents: workflows, guardrails, detected state',
	usage: 'atlas prime [--json]  — Markdown primer; --json emits the same model',
	async run(args) {
		const [detected, commands] = await Promise.all([detect(), commandList()]);
		if (!args.includes('--json')) return console.log(render(detected, commands));
		const workflows = WORKFLOWS.map(([goal, steps]) => ({ goal, steps }));
		console.log(JSON.stringify({ name: 'atlas', version: pkg.version, purpose: PURPOSE, commands, workflows, guardrails: GUARDRAILS, output: OUTPUT, detected }, null, 2));
	}
};
