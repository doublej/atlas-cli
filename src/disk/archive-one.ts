/**
 * Archive one project, log-first: snapshot → write `<file>.partial` → rename → verify
 * (archive mtree == source mtree, source unchanged) → manifest → remove the project.
 * Any failure removes what this run created and leaves the project as it was. A removal
 * that can't complete leaves the operation open, so `recover finish` can complete it.
 */
import { existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { freeBytes, writeJsonAtomic } from './fsutil';
import * as oplog from './oplog';
import { isCancelled } from './approval';
import { archiveFile, archiveMtree, leftOut, manifestPath, mtreeStats, sourceMtree, writeArchive, type Manifest } from './archive-core';
import type { ItemReport } from './report';

export interface ArchiveOpts {
	devRoot: string;
	archiveDir: string;
	compression: number;
	excludes: string[];
}

const MARGIN = 256 * 1024 * 1024;

/** Free bytes on the volume holding `path`, walking up to the nearest existing folder. */
function freeAt(path: string): number {
	let p = path;
	while (!existsSync(p)) p = dirname(p);
	return freeBytes(p);
}

/** Room first: the archive can be as big as the project; this Mac needs working headroom. */
export function roomProblem(bytes: number, o: ArchiveOpts): string | null {
	if (freeAt(o.archiveDir) < bytes + MARGIN) return `not enough room at the archive location (${o.archiveDir})`;
	if (freeAt(o.devRoot) < MARGIN) return 'not enough room on this Mac';
	return null;
}

export async function archiveProject(id: string, bytes: number, o: ArchiveOpts): Promise<ItemReport> {
	const src = join(o.devRoot, id);
	if (!existsSync(src)) return { item: id, outcome: 'skipped', reason: 'not found' };
	const room = roomProblem(bytes, o);
	if (room) {
		oplog.note({ op: 'archive', item: id, bytes }, 'skipped', room);
		return { item: id, outcome: 'skipped', reason: room };
	}
	const version = oplog.stamp();
	const file = archiveFile(o.archiveDir, id, version, o.compression);
	if (existsSync(file) || existsSync(`${file}.partial`)) return { item: id, outcome: 'refused', reason: `${file} already exists — never overwritten` };
	const opId = oplog.start({ op: 'archive', item: id, target: file, bytes, details: { version, source: src, compression: o.compression, excludes: o.excludes } });
	const freeStart = freeAt(o.devRoot);
	let r: ItemReport;
	try {
		r = await pipeline(opId, id, src, file, version, bytes, o);
	} catch (e) {
		rmSync(`${file}.partial`, { force: true });
		rmSync(file, { force: true });
		rmSync(manifestPath(file), { force: true });
		const reason = `${(e as Error).message} — project untouched`;
		oplog.end(opId, 'failed', { message: reason });
		return { item: id, outcome: 'failed', reason };
	}
	// Outside the try: once removal starts, a failure must never delete the verified archive.
	if (!r.ready) return r;
	const { ready: _, ...base } = r;
	return removeProject(opId, src, freeStart, base);
}

async function pipeline(opId: string, id: string, src: string, file: string, version: string, bytes: number, o: ArchiveOpts): Promise<ItemReport> {
	const cancelled = () => {
		oplog.end(opId, 'skipped', { message: 'cancelled' });
		return { item: id, outcome: 'skipped' as const, reason: 'cancelled' };
	};
	oplog.step(opId, 'snapshot');
	const [before, sum, omitted] = await Promise.all([sourceMtree(src, o.excludes, true), sourceMtree(src, o.excludes), leftOut(src, o.excludes)]);
	if (isCancelled()) return cancelled();
	oplog.step(opId, 'writing');
	mkdirSync(dirname(file), { recursive: true });
	await writeArchive(src, `${file}.partial`, o.excludes, o.compression);
	renameSync(`${file}.partial`, file);
	oplog.step(opId, 'verifying');
	const [archived, after] = await Promise.all([archiveMtree(file), sourceMtree(src, o.excludes, true)]);
	const changed = before !== after;
	const verified = archived === sum && !changed;
	const note = verified ? undefined : changed ? 'changed during archiving' : 'archive does not match the project';
	const manifest: Manifest = { version, project: id, source: src, createdAt: new Date().toISOString(), compression: o.compression, excludes: o.excludes, leftOut: omitted, ...mtreeStats(sum), mtree: sum, verified, note };
	writeJsonAtomic(manifestPath(file), manifest);
	const archiveBytes = statSync(file).size;
	oplog.step(opId, 'verified', { verified, archiveBytes });
	const base = { item: id, version, file, bytesBefore: bytes, archiveBytes };
	if (!verified) {
		oplog.end(opId, 'skipped', { message: `${note} — archive kept (not verified), project kept` });
		return { ...base, outcome: 'skipped', reason: `${note} — archive kept but not verified; project kept`, freed: 0 };
	}
	if (isCancelled()) return { ...cancelled(), ...base, reason: 'cancelled — verified archive kept, project kept' };
	return { ...base, outcome: 'done', ready: true };
}

/** The only place a project is deleted. Retries (Finder races .DS_Store); on failure the op stays open. */
export async function removeProject(opId: string, src: string, freeStart: number, base: ItemReport): Promise<ItemReport> {
	oplog.step(opId, 'removing');
	for (let attempt = 0; attempt < 3 && existsSync(src); attempt++) {
		try {
			rmSync(src, { recursive: true, force: true });
		} catch {
			await Bun.sleep(1000);
		}
	}
	if (existsSync(src)) {
		const reason = `archive verified, removal incomplete — finish with \`atlas disk recover finish ${opId}\``;
		return { ...base, outcome: 'failed', reason };
	}
	const freed = freeAt(dirname(src)) - freeStart;
	oplog.end(opId, 'done', { freed, details: { file: base.file, archiveBytes: base.archiveBytes } });
	return { ...base, outcome: 'done', freed };
}
