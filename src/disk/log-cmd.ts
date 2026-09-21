/**
 * `atlas disk log [--run ID] [--limit N] [--op OP] [--pending]` reads the operation log;
 * `atlas disk log trash|move|run|skip|note …` records manual cleanup steps (manual.ts).
 */
import { parseFlags } from './flags';
import { operations, type Operation } from './oplog';
import { human } from './fsutil';
import type { Report } from './report';
import { run as manual } from './manual';

const MANUAL = ['trash', 'move', 'run', 'skip', 'note'];

function line(o: Operation): string {
	const s = o.start;
	const size = s.bytes ? ` ${human(s.bytes)}` : '';
	const to = s.target ? ` → ${s.target}` : '';
	const result = o.end ? `${o.end.outcome}${o.end.message ? `: ${o.end.message}` : ''}` : 'INTERRUPTED';
	return `${s.at.slice(0, 19).replace('T', ' ')}  ${s.run}  ${s.actor.padEnd(8)} ${s.op.padEnd(14)} ${s.item}${to}${size}  [${result}]`;
}

export async function run(args: string[]): Promise<Report> {
	if (MANUAL.includes(args[0])) return manual(args);
	const f = parseFlags(args, ['pending']);
	let ops = operations();
	if (f.get('run')) ops = ops.filter((o) => o.start.run === f.get('run'));
	if (f.get('op')) ops = ops.filter((o) => o.start.op === f.get('op'));
	if (f.has('pending')) ops = ops.filter((o) => !o.end);
	ops = ops.slice(-(f.num('limit') ?? 50));
	return {
		command: 'log',
		exit: ops.length ? 'ok' : 'nothing',
		data: ops,
		text: ops.length ? ops.map(line).join('\n') : 'The operation log is empty.'
	};
}
