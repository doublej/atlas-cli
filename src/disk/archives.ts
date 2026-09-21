/** `atlas disk archives [list] | contents <id> | check <id>… | delete <id>… | prune [--keep N] | evict [<id>…]` */
import { parseFlags, type Flags } from './flags';
import { loadSettings, type Settings } from './settings';
import { human } from './fsutil';
import { approve, modeOf, policy } from './approval';
import { acquire } from './lock';
import { listVersions, resolveVersion } from './archive-list';
import { deleteVersion, pruneArchives } from './archive-prune';
import { check, contents, evictAll } from './archives-inspect';
import type { ArchiveVersion } from './types';
import type { ItemReport, Report } from './report';

const STORAGE: Record<ArchiveVersion['storage'], string> = { local: 'local only', uploading: 'uploading', uploaded: 'uploaded', cloud: 'cloud only', unknown: 'unknown', na: 'n/a' };

function listText(all: ArchiveVersion[], dir: string): string {
	const local = all.reduce((n, v) => n + v.localBytes, 0);
	const rows = all.map((v) => `${human(v.bytes).padStart(9)}  ${STORAGE[v.storage].padEnd(10)} ${v.verified ? 'verified   ' : 'unverified '} ${v.id}${v.verifyNote ? `  (${v.verifyNote})` : ''}`);
	return [...rows, '', `${all.length} version(s) in ${dir} · ${human(local)} on this Mac`].join('\n');
}

/** Each ref → a version, or a skipped item. */
function pick(all: ArchiveVersion[], refs: string[], exact: boolean) {
	const found: ArchiveVersion[] = [];
	const missing: ItemReport[] = [];
	for (const ref of refs) {
		const v = exact && !ref.includes('@') ? undefined : resolveVersion(all, ref);
		if (v) found.push(v);
		else missing.push({ item: ref, outcome: 'skipped', reason: exact ? 'no such version (use <category>/<project>@<version>)' : 'no such archive' });
	}
	return { found, missing };
}

const busy = (): Report | null => {
	const holder = acquire('archives');
	return holder ? { command: 'archives', exit: 'refused', text: `Another job is running: ${holder.job} (pid ${holder.pid}, since ${holder.since}).` } : null;
};

async function remove(all: ArchiveVersion[], f: Flags, s: Settings): Promise<Report> {
	const { found, missing } = pick(all, f.positional.slice(1), true);
	if (!found.length) return { command: 'archives', items: missing };
	const refusedLock = busy();
	if (refusedLock) return refusedLock;
	console.error(found.map((v) => `  ${human(v.bytes).padStart(9)}  ${v.id}${all.filter((x) => x.project === v.project).length === 1 ? '  (the ONLY version of this project)' : ''}`).join('\n'));
	const ok = await approve(policy('delete-archive', modeOf(f), s, f), `Delete ${found.length} archive version(s)? This cannot be undone.`);
	if (ok !== true) return { command: 'archives', items: [...missing, ...found.map((v) => ({ item: v.id, outcome: 'refused' as const, needs: ok.refuse }))] };
	return { command: 'archives', items: [...missing, ...found.map((v) => deleteVersion(v, 'deleted by hand'))] };
}

export async function run(args: string[]): Promise<Report> {
	const f = parseFlags(args);
	const s = loadSettings();
	const [verb = 'list', ...refs] = f.positional;
	const all = await listVersions(s.archiveDir);
	if (verb === 'list') return { command: 'archives', exit: all.length ? 'ok' : 'nothing', data: all, text: all.length ? listText(all, s.archiveDir) : `No archives in ${s.archiveDir}.` };
	if (verb === 'contents') {
		const v = resolveVersion(all, refs[0] ?? '');
		if (!v) throw new Error(`no archive '${refs[0] ?? ''}'`);
		return contents(v);
	}
	if (verb === 'check') {
		const { found, missing } = pick(all, refs, false);
		return { command: 'archives', items: [...missing, ...(await Promise.all(found.map(check)))] };
	}
	if (verb === 'delete') return remove(all, f, s);
	if (verb === 'prune' || verb === 'evict') {
		const refusedLock = busy();
		if (refusedLock) return refusedLock;
		if (verb === 'evict') {
			const { found, missing } = refs.length ? pick(all, refs, false) : { found: all, missing: [] };
			return { command: 'archives', items: [...missing, ...(await evictAll(found))] };
		}
		// Unattended/scheduled pruning is the standing keep-newest-N rule, never an ad-hoc --keep.
		const keep = modeOf(f) === 'interactive' ? (f.num('keep') ?? s.keepNewest) : s.keepNewest;
		if (!keep && modeOf(f) !== 'interactive') return { command: 'archives', exit: 'refused', text: 'Refused: unattended pruning needs the keep-newest-N rule (`atlas disk config set keepNewest N`).' };
		if (!keep) throw new Error('prune needs --keep N or `atlas disk config set keepNewest N`');
		return { command: 'archives', items: await pruneArchives(s.archiveDir, keep, modeOf(f), s, f) };
	}
	throw new Error(`unknown archives verb '${verb}' (list | contents | check | delete | prune | evict)`);
}
