import { basename } from 'node:path';
import type { Command } from '../types';
import { die } from '../util';
import { bootstrapJournal } from '../agent-log/init';

// The agent-log block opts the workspace into coordination (default mode: warn);
// a bare .atlas without the block is treated as observe-only by the resolver.
const TEMPLATE =
	JSON.stringify(
		{ description: '', archived: false, 'agent-log': { mode: 'warn', aliases: {} } },
		null,
		2
	) + '\n';

/** `atlas init` — write a starter .atlas metadata file and bootstrap the agent journal. */
export const init: Command = {
	name: 'init',
	summary: 'create a .atlas metadata file in the current folder',
	async run() {
		if (await Bun.file('.atlas').exists()) die('.atlas already exists');
		await Bun.write('.atlas', TEMPLATE);
		console.log(`Created .atlas in ${basename(process.cwd())}`);
		bootstrapJournal(process.cwd());
	}
};
