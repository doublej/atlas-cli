import type { Command } from './types';
import { tree } from './commands/tree';
import { init } from './commands/init';
import { info } from './commands/info';
import { newProject } from './commands/new';
import { scan } from './commands/scan';
import { open } from './commands/open';
import { run } from './commands/run';
import { pick } from './commands/pick';
import { jump, search } from './commands/search';
import { ports } from './commands/ports';
import { templates } from './commands/templates';
import { flow } from './commands/flow';
import { hosts } from './commands/hosts';
import { hostnames } from './commands/hostnames';
import { agentLog } from './commands/agent-log';
import { prime } from './commands/prime';
import { brief } from './commands/brief';
import { installAutocompletion } from './commands/install-autocompletion';
import { banner } from './logo';

export const COMMANDS: Command[] = [
	prime,
	tree,
	init,
	info,
	newProject,
	scan,
	open,
	run,
	pick,
	jump,
	search,
	ports,
	templates,
	flow,
	hosts,
	hostnames,
	agentLog,
	brief,
	installAutocompletion
];

export const findCommand = (name: string): Command | undefined =>
	COMMANDS.find((c) => c.name === name);

export function usage(): string {
	const width = Math.max(...COMMANDS.map((c) => c.name.length));
	const rows = COMMANDS.map((c) => `  ${c.name.padEnd(width)} ${c.summary}`).join('\n');
	return `${banner()}\n\nUsage: atlas <command> [args]\n       atlas <query>           search projects (anything that isn't a command)\n\nCommands:\n${rows}\n`;
}
