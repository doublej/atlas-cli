/** `archives contents <id>`, `archives check <id>…` and `archives evict [<id>…]`. */
import { freeBytes, human } from './fsutil';
import { dirname } from 'node:path';
import * as oplog from './oplog';
import { execOk } from './archive-exec';
import { archiveMtree, mtreeEntries, readManifest } from './archive-core';
import { download, evict } from './icloud';
import type { ArchiveVersion } from './types';
import type { ItemReport, Report } from './report';

/** Reading an archive's bytes needs them on this Mac. */
async function materialize(v: ArchiveVersion): Promise<void> {
	if (v.storage === 'cloud') await download(v.file, v.bytes);
}

export async function contents(v: ArchiveVersion): Promise<Report> {
	const m = readManifest(v.file);
	let files: { path: string; type: string; size: number }[];
	if (m) files = mtreeEntries(m.mtree);
	else {
		await materialize(v);
		files = (await execOk(['tar', '-tf', v.file])).split('\n').filter(Boolean).map((path) => ({ path, type: path.endsWith('/') ? 'dir' : 'file', size: 0 }));
	}
	const leftOut = m ? { excludes: m.excludes, paths: m.leftOut } : null;
	const text = [
		...files.map((e) => `${e.type === 'file' && m ? human(e.size).padStart(9) : ''.padStart(9)}  ${e.path}`),
		'',
		leftOut ? `Left out (${leftOut.excludes.join(', ')}):\n${leftOut.paths.map((p) => `  ${p}`).join('\n') || '  nothing matched'}` : 'Left out: unknown (legacy archive, no record of contents)'
	].join('\n');
	return { command: 'archives', exit: 'ok', data: { id: v.id, files, leftOut }, text };
}

export async function check(v: ArchiveVersion): Promise<ItemReport> {
	const m = readManifest(v.file);
	if (!m) return { item: v.id, outcome: 'skipped', reason: 'no record of contents to check against (legacy archive)' };
	await materialize(v);
	const ok = (await archiveMtree(v.file)) === m.mtree;
	return ok
		? { item: v.id, outcome: 'done', reason: `matches its record (${m.fileCount} files, ${human(m.totalBytes)})${m.verified ? '' : ` — but was not verified when made: ${m.note}`}`, matches: true }
		: { item: v.id, outcome: 'failed', reason: 'does NOT match the record made when it was written', matches: false };
}

/** Drop the local copy of uploaded archives (they stay in iCloud). Not a deletion. */
export async function evictAll(versions: ArchiveVersion[]): Promise<ItemReport[]> {
	const items: ItemReport[] = [];
	for (const v of versions) {
		if (v.storage !== 'uploaded') {
			items.push({ item: v.id, outcome: 'skipped', reason: v.storage === 'cloud' ? 'already cloud only' : `not uploaded (${v.storage})` });
			continue;
		}
		const opId = oplog.start({ op: 'evict', item: v.project, target: v.file, bytes: v.localBytes, details: { version: v.version } });
		const before = freeBytes(dirname(v.file));
		try {
			await evict(v.file);
		} catch (e) {
			oplog.end(opId, 'failed', { message: (e as Error).message });
			items.push({ item: v.id, outcome: 'failed', reason: (e as Error).message });
			continue;
		}
		const freed = freeBytes(dirname(v.file)) - before;
		oplog.end(opId, 'done', { freed });
		items.push({ item: v.id, outcome: 'done', freed });
	}
	return items;
}
