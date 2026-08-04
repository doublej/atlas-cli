import { basename } from 'node:path';
import type { Command } from '../types';
import { die } from '../util';
import { bootstrapJournal } from '../agent-log/init';

const TEMPLATE = JSON.stringify({ description: '', archived: false }, null, 2) + '\n';

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
