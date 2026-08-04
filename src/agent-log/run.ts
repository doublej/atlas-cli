/** `agent-log run` — wrap build/deploy/test so outcome + exit code are journaled even on failure. */
import { type Options, USAGE, die } from './args';
import { begin, end } from './events';

export async function runWrapped(
	operation: string,
	options: Options,
	command: string[]
): Promise<never> {
	if (!['build', 'deploy', 'test'].includes(operation) || command.length === 0) die(USAGE);
	const summary = command.join(' ');
	const opId = begin(operation, options, summary);
	console.error(`agent-log: ${opId} started`);
	const child = Bun.spawn(command, { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' });
	const exitCode = await child.exited;
	end({ opId, outcome: exitCode === 0 ? 'ok' : 'failed', summary, extra: { exit_code: exitCode } });
	// Propagate the wrapped command's exit code verbatim (tested behavior).
	process.exit(exitCode);
}
