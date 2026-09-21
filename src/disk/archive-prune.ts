/** Deleting archive versions: one by id, or everything beyond the newest N per project. */
import { rmSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Flags } from './flags';
import type { Settings } from './settings';
import { freeBytes, human } from './fsutil';
import * as oplog from './oplog';
import { approve, isCancelled, policy, type Mode } from './approval';
import { manifestPath } from './archive-core';
import { listVersions, pruneCandidates } from './archive-list';
import type { ArchiveVersion } from './types';
import type { ItemReport } from './report';

/** Remove one version's file and manifest, log-first. */
export function deleteVersion(v: ArchiveVersion, why: string): ItemReport {
	const held = oplog.isHeld(v.project);
	if (held) return { item: v.id, outcome: 'refused', reason: `held by interrupted operation ${held.start.id}`, needs: '`atlas disk recover`' };
	const opId = oplog.start({ op: 'delete-archive', item: v.project, target: v.file, bytes: v.bytes, details: { version: v.version, why } });
	const before = freeBytes(dirname(v.file));
	rmSync(v.file, { force: true });
	rmSync(manifestPath(v.file), { force: true });
	const freed = freeBytes(dirname(v.file)) - before;
	oplog.end(opId, 'done', { freed });
	return { item: v.id, outcome: 'done', freed };
}

/** Keep the newest `keep` per project; never a project's only version (keep ≥ 1). */
export async function pruneArchives(archiveDir: string, keep: number, mode: Mode, s: Settings, f: Flags): Promise<ItemReport[]> {
	const doomed = pruneCandidates(await listVersions(archiveDir), keep);
	if (!doomed.length) return [];
	const total = human(doomed.reduce((n, v) => n + v.bytes, 0));
	if (mode === 'interactive') console.log(`Prune (keep newest ${keep}):\n${doomed.map((v) => `  ${v.id}`).join('\n')}`);
	const ok = await approve(policy('prune-archives', mode, s, f), `Delete ${doomed.length} old archive version(s) (${total})?`);
	if (ok !== true) return doomed.map((v) => ({ item: v.id, outcome: 'refused', needs: ok.refuse }));
	return doomed.map((v) => (isCancelled() ? { item: v.id, outcome: 'skipped', reason: 'cancelled' } : deleteVersion(v, `keep newest ${keep}`)));
}
