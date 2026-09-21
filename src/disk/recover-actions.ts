/**
 * Finish or undo one interrupted operation. Archive and restore know their phases; every
 * other op (clean, trim, manual-*, evict, delete-archive, recover) is only closed — a
 * deletion can't be undone and a half-run command is rerun by hand.
 */
import { existsSync, renameSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { duBytes, freeBytes } from './fsutil';
import * as oplog from './oplog';
import { archiveMtree, manifestPath, readManifest } from './archive-core';
import { archiveProject, removeProject } from './archive-one';
import { listVersions } from './archive-list';
import { place, restoreVersion } from './restore-one';
import type { ItemReport } from './report';

export type Action = 'finish' | 'undo';
type Op = oplog.Operation;

const phase = (op: Op) => op.steps.at(-1)?.phase ?? 'started';
const d = (op: Op) => (op.start.details ?? {}) as Record<string, unknown>;
const close = (op: Op, outcome: oplog.Outcome, message: string): ItemReport => {
	oplog.end(op.start.id, outcome, { message: `recover: ${message}` });
	return { item: op.start.item, outcome: 'done', reason: message, op: op.start.id };
};
const fail = (op: Op, reason: string): ItemReport => ({ item: op.start.item, outcome: 'failed', reason: `${reason} — nothing changed, still open`, op: op.start.id });

/** archiveDir/<category>/<file> → its version record. */
const versionAt = async (file: string) => (await listVersions(dirname(dirname(file)))).find((v) => v.file === file);

async function verifiedArchive(file: string): Promise<boolean> {
	const m = readManifest(file);
	return !!m?.verified && existsSync(file) && (await archiveMtree(file)) === m.mtree;
}

const dropNewArchive = (file: string) => [`${file}.partial`, file, manifestPath(file)].forEach((p) => rmSync(p, { force: true }));

async function archiveAction(op: Op, action: Action): Promise<ItemReport> {
	const file = op.start.target!;
	const src = (d(op).source as string | undefined) ?? '';
	if (phase(op) === 'removing') return action === 'finish' ? finishRemoval(op, file, src) : undoRemoval(op, file, src);
	dropNewArchive(file);
	if (action === 'undo') return close(op, 'skipped', 'undone — the unfinished archive was removed, the project was never touched');
	close(op, 'failed', 'interrupted before verification — unfinished archive removed, archiving again');
	if (!existsSync(src)) return { item: op.start.item, outcome: 'skipped', reason: `${src} not found — nothing to archive` };
	const devRoot = dirname(dirname(src));
	return archiveProject(op.start.item, duBytes(src), { devRoot, archiveDir: dirname(dirname(file)), compression: Number(d(op).compression ?? 1), excludes: (d(op).excludes as string[]) ?? [] });
}

async function finishRemoval(op: Op, file: string, src: string): Promise<ItemReport> {
	if (!(await verifiedArchive(file))) return fail(op, 'the archive no longer checks out as verified, so the project is not removed');
	return removeProject(op.start.id, src, freeBytes(dirname(src)), { item: op.start.item, outcome: 'done', file });
}

/** Put the project back from its verified archive; the half-removed remainder is kept aside until that worked. */
async function undoRemoval(op: Op, file: string, src: string): Promise<ItemReport> {
	const v = await versionAt(file);
	if (!v || !(await verifiedArchive(file))) return fail(op, 'no verified archive to restore from');
	const aside = join(dirname(src), `.atlas-remainder-${basename(src)}-${op.start.id}`);
	if (existsSync(src)) renameSync(src, aside);
	const r = await restoreVersion(v, dirname(dirname(src)), false);
	if (r.outcome !== 'done') {
		if (existsSync(aside) && !existsSync(src)) renameSync(aside, src);
		return fail(op, `restore failed: ${r.reason}`);
	}
	rmSync(aside, { recursive: true, force: true });
	return close(op, 'skipped', `undone — ${op.start.item} restored from its verified archive`);
}

async function restoreAction(op: Op, action: Action): Promise<ItemReport> {
	const { file, tmp, keepArchive } = d(op) as { file: string; tmp: string; keepArchive: boolean };
	const dest = op.start.target!;
	if (action === 'undo' || existsSync(dest)) {
		rmSync(tmp, { recursive: true, force: true });
		if (action === 'undo') return close(op, 'skipped', existsSync(dest) ? 'temp folder removed; the project was already in place and stays' : 'temp folder removed; the archive still exists');
		if (!keepArchive) dropNewArchive(file);
		return close(op, 'done', `finished — ${dest} in place${keepArchive ? '' : ', archive deleted'}`);
	}
	const v = await versionAt(file);
	if (!v) return fail(op, `the archive ${file} is gone and ${dest} does not exist — check the temp folder ${tmp}`);
	if (phase(op) === 'moving' && existsSync(join(tmp, basename(dest)))) return place(op.start.id, v, tmp, dest, keepArchive);
	rmSync(tmp, { recursive: true, force: true });
	close(op, 'failed', 'interrupted — temp folder removed, restoring again');
	return restoreVersion(v, dirname(dirname(dest)), keepArchive);
}

export async function recoverOne(op: Op, action: Action): Promise<ItemReport> {
	if (op.start.op === 'archive') return archiveAction(op, action);
	if (op.start.op === 'restore') return restoreAction(op, action);
	return action === 'finish'
		? close(op, 'failed', `closed — a ${op.start.op} can't be resumed automatically; rerun it if still needed`)
		: close(op, 'skipped', `closed — a ${op.start.op} can't be undone (deletions are not reversible)`);
}

/** What finish/undo would do, for `recover list`. */
export function describe(op: Op): { finish: string; undo: string } {
	const p = phase(op);
	if (op.start.op === 'archive' && p === 'removing') return { finish: 're-check the archive, then complete the removal', undo: 'restore the project from its verified archive' };
	if (op.start.op === 'archive') return { finish: 'discard the unfinished archive and archive again', undo: 'discard the unfinished archive (project untouched)' };
	if (op.start.op === 'restore') return { finish: 'complete the restore', undo: 'remove the temp folder (the archive still exists)' };
	return { finish: 'close the record (rerun by hand)', undo: 'close the record (not reversible)' };
}
