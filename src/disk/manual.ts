/**
 * Manual cleanup steps, recorded in the operation log (replaces `_management/disk/hc.sh`):
 *   atlas disk log trash <path>… [--reason …]      Finder Trash, Put Back works
 *   atlas disk log move <src> <dst> [--reason …]   never overwrites
 *   atlas disk log run [--path P] -- <command…>    exit code, and du before/after of P
 *   atlas disk log skip <path> --reason …
 *   atlas disk log note -- <text>
 * Explicit actions: no approval prompt, but the ones that change files take the job lock.
 */
import { existsSync, lstatSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { trashPath } from './clean-delete';
import { parseFlags } from './flags';
import { duBytes, human } from './fsutil';
import { acquire } from './lock';
import { end, note, start } from './oplog';
import type { ItemReport, Report } from './report';

const exists = (p: string) => lstatSync(p, { throwIfNoEntry: false }) !== undefined;
const fail = (e: unknown) => (e instanceof Error ? e.message : String(e));

function lock(): void {
	const holder = acquire('manual');
	if (holder) throw new Error(`another job is running: ${holder.job} (pid ${holder.pid})`);
}

async function trash(paths: string[], reason?: string): Promise<ItemReport[]> {
	lock();
	const items: ItemReport[] = [];
	for (const p of paths.map((x) => resolve(x))) {
		if (!exists(p)) {
			note({ op: 'manual-trash', item: p, details: { reason } }, 'failed', 'missing');
			items.push({ item: p, outcome: 'failed', reason: 'missing' });
			continue;
		}
		const bytes = duBytes(p);
		const id = start({ op: 'manual-trash', item: p, target: 'Trash', bytes, details: { reason } });
		try {
			const t = await trashPath(p);
			end(id, 'done', { details: t });
			items.push({ item: p, outcome: 'done', bytes, ...t, reason: t.putBack === true ? undefined : `Put Back record ${t.putBack === false ? 'not found' : 'unverifiable'}` });
		} catch (e) {
			end(id, 'failed', { message: fail(e) });
			items.push({ item: p, outcome: 'failed', reason: fail(e) });
		}
	}
	return items;
}

function move(src: string, dst: string, reason?: string): ItemReport {
	lock();
	if (!exists(src)) {
		note({ op: 'manual-move', item: src, target: dst, details: { reason } }, 'failed', 'source missing');
		return { item: src, outcome: 'failed', reason: 'source missing' };
	}
	if (exists(dst)) {
		note({ op: 'manual-move', item: src, target: dst, details: { reason } }, 'refused', 'target exists');
		return { item: src, outcome: 'refused', reason: `${dst} exists — a move never overwrites` };
	}
	const bytes = duBytes(src);
	const id = start({ op: 'manual-move', item: src, target: dst, bytes, details: { reason } });
	mkdirSync(dirname(dst), { recursive: true });
	// mv -n: never overwrites, even if dst appears between the check and the move; crosses volumes
	const r = Bun.spawnSync(['mv', '-n', src, dst], { stderr: 'pipe' });
	const ok = r.exitCode === 0 && exists(dst) && !exists(src);
	end(id, ok ? 'done' : 'failed', ok ? {} : { message: r.stderr.toString().trim() || 'target appeared; nothing moved' });
	return { item: src, outcome: ok ? 'done' : 'failed', target: dst, bytes, reason: ok ? undefined : 'move failed (see log)' };
}

function runCommand(cmd: string[], path?: string): ItemReport {
	lock();
	const shown = cmd.join(' ');
	const before = path && existsSync(path) ? duBytes(path) : undefined;
	const id = start({ op: 'manual-run', item: shown, target: path, bytes: before, details: { path } });
	// one argument = a shell line (pipes, globs); several = an argv, run as is
	const argv = cmd.length === 1 ? ['/bin/sh', '-c', cmd[0]] : cmd;
	const r = Bun.spawnSync(argv, { stdio: ['inherit', 'inherit', 'inherit'] });
	const after = path ? (existsSync(path) ? duBytes(path) : 0) : undefined;
	const freed = before !== undefined && after !== undefined ? before - after : undefined;
	end(id, r.exitCode === 0 ? 'done' : 'failed', { message: `exit ${r.exitCode}`, freed, details: { exit: r.exitCode, before, after } });
	const size = freed !== undefined ? ` (${human(before ?? 0)} → ${human(after ?? 0)})` : '';
	return { item: shown, outcome: r.exitCode === 0 ? 'done' : 'failed', exit: r.exitCode, freed, reason: `exit ${r.exitCode}${size}` };
}

export async function run(args: string[]): Promise<Report> {
	const dash = args.indexOf('--');
	const [sub, ...head] = dash < 0 ? args : args.slice(0, dash);
	const tail = dash < 0 ? [] : args.slice(dash + 1);
	const f = parseFlags(head);
	const reason = f.get('reason');
	const command = `log ${sub}`;
	switch (sub) {
		case 'trash':
			if (!f.positional.length) throw new Error('usage: atlas disk log trash <path>… [--reason …]');
			return { command, items: await trash(f.positional, reason) };
		case 'move':
			if (f.positional.length !== 2) throw new Error('usage: atlas disk log move <src> <dst> [--reason …]');
			return { command, items: [move(resolve(f.positional[0]), resolve(f.positional[1]), reason)] };
		case 'run':
			if (!tail.length) throw new Error('usage: atlas disk log run [--path P] -- <command…>');
			return { command, items: [runCommand(tail, f.get('path') && resolve(f.get('path') as string))] };
		case 'skip': {
			if (f.positional.length !== 1 || !reason) throw new Error('usage: atlas disk log skip <path> --reason …');
			const p = resolve(f.positional[0]);
			note({ op: 'manual-skip', item: p, details: { reason } }, 'skipped', reason);
			return { command, exit: 'ok', items: [{ item: p, outcome: 'skipped', reason }] };
		}
		case 'note': {
			const text = [...f.positional, ...tail].join(' ').trim();
			if (!text) throw new Error('usage: atlas disk log note -- <text>');
			note({ op: 'manual-note', item: text }, 'done', text);
			return { command, items: [{ item: text, outcome: 'done' }] };
		}
	}
	throw new Error(`unknown manual step '${sub}' (trash|move|run|skip|note)`);
}
