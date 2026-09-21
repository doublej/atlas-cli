/**
 * Restore one archive version, log-first: download if cloud-only → unpack into a temp folder
 * on the destination's volume → verify against the manifest → rename into place → delete
 * the archive (unless kept). Never overwrites an existing folder.
 */
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { freeBytes, human } from './fsutil';
import * as oplog from './oplog';
import { execOk } from './archive-exec';
import { manifestPath, readManifest, sourceMtree } from './archive-core';
import { download } from './icloud';
import type { ArchiveVersion } from './types';
import type { ItemReport } from './report';

export const tempDirFor = (devRoot: string, v: ArchiveVersion): string =>
	join(devRoot, v.project.split('/')[0], `.atlas-restore-${v.project.split('/')[1]}-${v.version}`);

export async function restoreVersion(v: ArchiveVersion, devRoot: string, keepArchive: boolean): Promise<ItemReport> {
	const dest = join(devRoot, v.project);
	if (existsSync(dest)) return { item: v.id, outcome: 'refused', reason: `${dest} already exists — refusing to overwrite` };
	const manifest = readManifest(v.file);
	const need = (manifest?.totalBytes ?? v.bytes) + (v.storage === 'cloud' ? v.bytes : 0);
	mkdirSync(join(devRoot, v.project.split('/')[0]), { recursive: true });
	if (freeBytes(join(devRoot, v.project.split('/')[0])) < need) return { item: v.id, outcome: 'skipped', reason: `not enough room on this Mac (needs ${human(need)})` };
	const tmp = tempDirFor(devRoot, v);
	const opId = oplog.start({ op: 'restore', item: v.project, target: dest, bytes: v.bytes, details: { version: v.version, file: v.file, tmp, keepArchive } });
	try {
		await unpack(opId, v, tmp, manifest?.mtree);
	} catch (e) {
		rmSync(tmp, { recursive: true, force: true });
		const reason = `${(e as Error).message} — archive untouched`;
		oplog.end(opId, 'failed', { message: reason });
		return { item: v.id, outcome: 'failed', reason };
	}
	return place(opId, v, tmp, dest, keepArchive, manifest ? '' : ' (legacy archive: no record of contents, not verified)');
}

async function unpack(opId: string, v: ArchiveVersion, tmp: string, mtree: string | undefined): Promise<void> {
	if (v.storage === 'cloud') {
		oplog.step(opId, 'downloading');
		await download(v.file, v.bytes);
	}
	oplog.step(opId, 'unpacking', { tmp });
	rmSync(tmp, { recursive: true, force: true });
	mkdirSync(tmp, { recursive: true });
	await execOk(['tar', '-xpf', v.file, '-C', tmp]);
	const name = v.project.split('/')[1];
	if (!existsSync(join(tmp, name))) throw new Error(`archive holds no ${name}/ folder`);
	if (mtree !== undefined && (await sourceMtree(join(tmp, name), [])) !== mtree) throw new Error('unpacked files do not match the archive record');
}

/** Move into place, drop the temp folder, then (unless kept) the archive. Also `recover finish`'s tail. */
export function place(opId: string, v: ArchiveVersion, tmp: string, dest: string, keepArchive: boolean, note = ''): ItemReport {
	oplog.step(opId, 'moving');
	if (existsSync(dest)) {
		rmSync(tmp, { recursive: true, force: true });
		oplog.end(opId, 'refused', { message: `${dest} appeared meanwhile — not overwritten` });
		return { item: v.id, outcome: 'refused', reason: `${dest} already exists — refusing to overwrite` };
	}
	renameSync(join(tmp, v.project.split('/')[1]), dest);
	rmSync(tmp, { recursive: true, force: true });
	if (!keepArchive) {
		oplog.step(opId, 'deleting-archive');
		rmSync(v.file, { force: true });
		rmSync(manifestPath(v.file), { force: true });
	}
	oplog.end(opId, 'done', { message: `restored to ${dest}${keepArchive ? ', archive kept' : ''}${note}` });
	return { item: v.id, outcome: 'done', reason: note.trim() || undefined, path: dest, archiveKept: keepArchive };
}
