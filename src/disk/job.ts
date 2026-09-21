/**
 * `atlas disk job --log FILE -- <subcommand> [args…]` — run one disk subcommand with its output
 * in FILE, then write `FILE.exit` with its exit code. The exit record is what lets a UI that
 * started the job (and may have restarted since) tell a finished job from a running one.
 * Cancel is SIGINT to the process group: the wrapper ignores it, the subcommand stops at its
 * next safe point, and the exit code is still written.
 */
import { closeSync, openSync, writeFileSync } from 'node:fs';
import { EXIT, type ExitName, type Report } from './report';

export async function run(args: string[]): Promise<Report> {
	const sep = args.indexOf('--');
	const logAt = args.indexOf('--log');
	const log = logAt >= 0 && logAt < sep ? args[logAt + 1] : undefined;
	const sub = sep >= 0 ? args.slice(sep + 1).filter((a) => a !== '--json') : [];
	if (!log || !sub.length) throw new Error('usage: atlas disk job --log FILE -- <subcommand> [args…]');
	process.on('SIGINT', () => {}); // the child handles it; this process must live to write the exit code
	const fd = openSync(log, 'a');
	const child = Bun.spawn([process.execPath, process.argv[1], 'disk', ...sub], { stdin: 'ignore', stdout: fd, stderr: fd });
	const code = await child.exited;
	closeSync(fd);
	writeFileSync(`${log}.exit`, String(code));
	const name = (Object.entries(EXIT).find(([, n]) => n === code)?.[0] ?? 'error') as ExitName;
	return { command: 'job', exit: name, text: '' };
}
