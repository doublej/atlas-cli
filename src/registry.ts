import type { Command } from './types';
import { tree } from './commands/tree';
import { init } from './commands/init';
import { info } from './commands/info';
import { newProject } from './commands/new';
import { scan } from './commands/scan';
import { open } from './commands/open';
import { run } from './commands/run';
import { stop } from './commands/stop';
import { ps } from './commands/ps';
import { kill } from './commands/kill';
import { set } from './commands/set';
import { daemons } from './commands/daemons';
import { pick } from './commands/pick';
import { jump, search } from './commands/search';
import { ports } from './commands/ports';
import { templates } from './commands/templates';
import { flow } from './commands/flow';
import { hosts } from './commands/hosts';
import { hostnames } from './commands/hostnames';
import { services } from './commands/services';
import { disk } from './commands/disk';
import { agentLog } from './commands/agent-log';
import { prime } from './commands/prime';
import { brief } from './commands/brief';
import { board } from './commands/board';
import { installAutocompletion } from './commands/install-autocompletion';
import { banner } from './logo';

export const COMMANDS: Command[] = [
	prime,
	tree,
	init,
	info,
	set,
	newProject,
	scan,
	open,
	run,
	stop,
	ps,
	kill,
	pick,
	jump,
	search,
	ports,
	templates,
	flow,
	hosts,
	hostnames,
	services,
	daemons,
	disk,
	agentLog,
	board,
	brief,
	installAutocompletion
];

export const findCommand = (name: string): Command | undefined =>
	COMMANDS.find((c) => c.name === name);

/** How to read further, and what is left out on purpose (agents have better tools for those). */
export const HELP_FOOTER = `\`atlas <command> --help\` for flags. \`--json\` on every command that prints data, except the text-only ones \`atlas prime\` lists.
Not here on purpose: iTerm/Finder (GUI only, in the web console) and git, README, beads (use git, cat, bd directly).`;

export function usage(): string {
	const width = Math.max(...COMMANDS.map((c) => c.name.length));
	const rows = COMMANDS.map((c) => `  ${c.name.padEnd(width)} ${c.summary}`).join('\n');
	return `${banner()}\n\nUsage: atlas <command> [args]\n       atlas <query>           search projects (anything that isn't a command)\n\nCommands:\n${rows}\n\n${HELP_FOOTER}\n`;
}
