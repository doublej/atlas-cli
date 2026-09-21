/** `atlas disk recover [list] | finish <op-id> | undo <op-id>` — resolve interrupted operations. */
import { parseFlags } from './flags';
import * as oplog from './oplog';
import { acquire } from './lock';
import { describe, recoverOne, type Action } from './recover-actions';
import type { Report } from './report';

function listText(ops: oplog.Operation[]): string {
	if (!ops.length) return 'No interrupted operations.';
	return ops
		.map((o) => {
			const { finish, undo } = describe(o);
			const at = o.steps.at(-1)?.phase ?? 'start';
			return `${o.start.id}  ${o.start.op} ${o.start.item}${o.start.target ? ` → ${o.start.target}` : ''}\n    interrupted at '${at}' (${o.start.at.slice(0, 19).replace('T', ' ')}, ${o.start.actor})\n    finish: ${finish}\n    undo:   ${undo}`;
		})
		.join('\n\n');
}

export async function run(args: string[]): Promise<Report> {
	const f = parseFlags(args);
	const [verb = 'list', id] = f.positional;
	const open = oplog.pending();
	if (verb === 'list') {
		const data = open.map((o) => ({ ...o, ...describe(o) }));
		return { command: 'recover', exit: open.length ? 'ok' : 'nothing', data, text: listText(open) };
	}
	if (verb !== 'finish' && verb !== 'undo') throw new Error(`unknown recover verb '${verb}' (list | finish <op-id> | undo <op-id>)`);
	const op = open.find((o) => o.start.id === id);
	if (!op) throw new Error(`no interrupted operation '${id ?? ''}' — see \`atlas disk recover list\``);
	const holder = acquire('recover');
	if (holder) return { command: 'recover', exit: 'refused', text: `Another job is running: ${holder.job} (pid ${holder.pid}, since ${holder.since}).` };
	const own = oplog.start({ op: 'recover', item: op.start.item, details: { of: op.start.id, action: verb } });
	const item = await recoverOne(op, verb as Action);
	oplog.end(own, item.outcome, { message: item.reason });
	return { command: 'recover', items: [item] };
}
