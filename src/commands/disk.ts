import type { Command } from '../types';
import { emit, EXIT, type Report } from '../disk/report';
import { pending } from '../disk/oplog';
import { run as analyze } from '../disk/analyze';
import { run as archive } from '../disk/archive';
import { run as archives } from '../disk/archives';
import { run as restore } from '../disk/restore';
import { run as recover } from '../disk/recover';
import { run as scan } from '../disk/scan';
import { run as clean } from '../disk/clean';
import { run as trim } from '../disk/trim';
import { run as schedule } from '../disk/schedule';
import { run as doctor } from '../disk/doctor';
import { run as config } from '../disk/config-cmd';
import { run as log } from '../disk/log-cmd';
import { run as tui } from '../disk/tui';

const SUBCOMMANDS: Record<string, [(args: string[]) => Promise<Report>, string]> = {
	analyze: [analyze, 'projects under the dev folder: size, age, state, git [--min-size MB] [--cached]'],
	archive: [archive, 'archive projects: --eligible | <category/project>… [--dry-run] [--unattended]'],
	archives: [archives, 'archive versions: list | contents <id> | check <id> | delete <id>… | prune | evict'],
	restore: [restore, 'restore projects: <category/project | version id>… [--keep-archive] [--dry-run]'],
	scan: [scan, 'rebuildable folders under ~, largest first [--min-size MB] [--risk R] [--cached] [--notify]'],
	clean: [clean, 'delete scanned folders: <path>… | --risk R --all [--trash|--permanent] [--dry-run]'],
	trim: [trim, "trim developer-tool caches with each tool's own clean-up [--rust-sweep] [--dry-run]"],
	schedule: [schedule, 'weekly jobs: status | enable|disable <scan|trim> | set <scan|trim> --at "Sun 10:00"'],
	recover: [recover, 'interrupted operations: list | finish <op-id> | undo <op-id>'],
	log: [log, 'operation log [--run ID] [--pending]; record manual steps: trash|move|run|skip|note'],
	config: [config, 'thresholds, rules, locations: get [key] | set <key> <value> | reset <key>'],
	doctor: [doctor, 'check schedules, archive location, tools and interrupted operations (exit 3 = problems found)'],
	tui: [tui, 'open the terminal screen (archive-eligible projects ⇄ archive versions)']
};

const HELP = `atlas disk — free disk space: archive idle projects, clean rebuildable folders, trim tool caches

Usage: atlas disk <subcommand> [args] [--json]

${Object.entries(SUBCOMMANDS)
	.map(([name, [, summary]]) => `  ${name.padEnd(9)} ${summary}`)
	.join('\n')}

Every subcommand takes --json. Changes confirm interactively; --unattended runs only what the
approval policy allows without a prompt and refuses the rest (with the approval it needs).
Exit: 0 ok · 1 error · 2 nothing to do · 3 partly failed · 4 refused.`;

/** "The next run shows it": every disk command warns about interrupted operations first. */
function warnPending(sub: string): void {
	if (sub === 'recover') return;
	const open = pending();
	if (open.length) console.error(`⚠ ${open.length} interrupted operation(s) — see \`atlas disk recover list\`\n`);
}

export const disk: Command = {
	name: 'disk',
	summary: 'free disk space: archive idle projects, clean rebuildable folders, trim caches',
	usage: HELP,
	async run(args) {
		const [sub, ...rest] = args;
		const entry = sub ? SUBCOMMANDS[sub] : undefined;
		if (!entry) {
			console.log(HELP);
			if (sub) process.exitCode = EXIT.error;
			return;
		}
		const json = rest.includes('--json');
		warnPending(sub);
		try {
			process.exitCode = emit(await entry[0](rest), json);
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			if (json) console.log(JSON.stringify({ command: sub, exit: 'error', error: message }));
			else console.error(`atlas disk ${sub}: ${message}`);
			process.exitCode = EXIT.error;
		}
	}
};
