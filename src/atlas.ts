#!/usr/bin/env bun
import { findCommand, usage } from './registry';
import { search } from './commands/search';

async function main(): Promise<void> {
	const [name, ...args] = process.argv.slice(2);
	if (!name || name === 'help' || name === '--help' || name === '-h') {
		console.log(usage());
		return;
	}
	const cmd = findCommand(name);
	// Not a command → treat the whole arg list as a project search query.
	await (cmd ? cmd.run(args) : search.run([name, ...args]));
}

main().catch((e: unknown) => {
	console.error(e instanceof Error ? e.message : String(e));
	process.exit(1);
});
