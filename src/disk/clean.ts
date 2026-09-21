/**
 * `atlas disk clean [<path>…] [--risk R] [--all] [--trash|--permanent] [--dry-run] [--unattended] [--json]`
 * — delete folders from the saved scan. Interactive with no paths: pick, look inside, confirm.
 * Every folder is re-checked against the scan just before it goes; review-level folders go to
 * the Trash by default, the rest are deleted permanently.
 */
import { dirname, resolve } from 'node:path';
import { approve, isCancelled, modeOf, policy, trapCancel, type Mode } from './approval';
import { deletePermanent, recheck, trashPath } from './clean-delete';
import { pickFolders, planText, previewData, previewText, type Preview } from './clean-pick';
import { parseFlags, type Flags } from './flags';
import { freeBytes, human, writeJsonAtomic } from './fsutil';
import { acquire } from './lock';
import { end, isHeld, start } from './oplog';
import { renderItems, type ItemReport, type Report } from './report';
import { finalize, loadScan, type SavedScan } from './scan';
import { RISK_ORDER } from './scan-rules';
import { loadSettings, statePath, type Settings } from './settings';
import type { FolderRow, Risk } from './types';

/** Deleting a parent covers its children: drop selected rows inside another selected row. */
export const dropCovered = (rows: FolderRow[]): FolderRow[] => rows.filter((r) => !rows.some((p) => r.path.startsWith(`${p.path}/`)));

const refuse = (r: FolderRow | string, reason: string, needs?: string): ItemReport => ({ item: typeof r === 'string' ? r : r.path, outcome: 'refused', reason, needs });
const skip = (r: FolderRow, reason: string): ItemReport => ({ item: r.path, outcome: 'skipped', reason });

/** Which rows the command line names; paths not in the scan are refused. */
async function select(all: FolderRow[], f: Flags, mode: Mode): Promise<{ rows: FolderRow[]; refused: ItemReport[] } | string> {
	const risk = f.get('risk') as Risk | undefined;
	const pool = risk ? all.filter((r) => r.risk === risk) : all;
	if (f.positional.length) {
		const paths = f.positional.map((p) => resolve(p));
		const rows = pool.filter((r) => paths.includes(r.path));
		const refused = paths.filter((p) => !rows.some((r) => r.path === p)).map((p) => refuse(p, `not in the saved scan${risk ? ` at risk ${risk}` : ''} — unclassified folders are never deleted`));
		return { rows, refused };
	}
	if (f.has('all')) return { rows: pool, refused: [] };
	if (mode !== 'interactive' || !process.stdin.isTTY) return 'Name folders, or pass --all (with --risk R) — there is no terminal to pick from.';
	return { rows: await pickFolders(pool), refused: [] };
}

/** Unattended: the policy per risk, and in-use folders are skipped. Interactive: one confirmation. */
async function gate(rows: FolderRow[], mode: Mode, s: Settings, f: Flags, toTrash: (r: FolderRow) => boolean, previews: Preview[]): Promise<{ go: FolderRow[]; out: ItemReport[] }> {
	if (mode === 'interactive') {
		for (const r of rows) previews.push(await previewData(r));
		// With --json the previews travel in `data.preview` instead (a UI shows them before it confirms).
		if (!f.has('json')) {
			for (const [i, r] of rows.entries()) console.log(`${previewText(r, previews[i])}\n`);
			console.log(planText(rows, toTrash));
		}
		if (f.has('dry-run')) return { go: rows, out: [] };
		const ok = await approve(policy('clean-rebuildable', mode, s, f), `Delete these ${rows.length} folder(s)?`);
		return ok === true ? { go: rows, out: [] } : { go: [], out: rows.map((r) => refuse(r, 'not approved', ok.refuse)) };
	}
	const go: FolderRow[] = [];
	const out: ItemReport[] = [];
	for (const r of rows) {
		const v = policy(`clean-${r.risk}`, mode, s, f);
		if (v !== 'allow') out.push(refuse(r, `${r.risk}-level cleanup needs approval`, v === 'confirm' ? 'an interactive confirmation' : v.refuse));
		else if (r.inUse) out.push(skip(r, `in use: ${r.inUse}`));
		else go.push(r);
	}
	return { go, out };
}

async function removeOne(r: FolderRow, trash: boolean): Promise<ItemReport> {
	const held = isHeld(r.path);
	if (held) return skip(r, `held by interrupted operation ${held.start.id} — see \`atlas disk recover list\``);
	const changed = await recheck(r);
	if (changed) return skip(r, changed);
	const before = freeBytes(dirname(r.path));
	const id = start({ op: 'clean', item: r.path, target: trash ? 'Trash' : undefined, bytes: r.bytes, details: { risk: r.risk, mode: trash ? 'trash' : 'permanent' } });
	try {
		const t = trash ? await trashPath(r.path) : (deletePermanent(r.path), null);
		const freed = freeBytes(dirname(r.path)) - before;
		end(id, 'done', { freed, details: { movedToTrash: trash ? r.bytes : 0, ...t } });
		return { item: r.path, outcome: 'done', bytes: r.bytes, freed, movedToTrash: trash ? r.bytes : 0, ...t, reason: t && t.putBack !== true ? `Put Back record ${t.putBack === false ? 'not found' : 'unverifiable'}` : undefined };
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		end(id, 'failed', { message });
		return { item: r.path, outcome: 'failed', reason: message };
	}
}

/** Deleted folders (and anything inside them) leave the saved scan, so `--cached` stays true. */
function forget(scan: SavedScan, items: ItemReport[]): void {
	const gone = items.filter((i) => i.outcome === 'done').map((i) => i.item);
	if (!gone.length) return;
	const left = scan.folders.filter((r) => !gone.some((g) => r.path === g || r.path.startsWith(`${g}/`)));
	writeJsonAtomic(statePath('scan.json'), { ...scan, ...finalize(left) });
}

function summary(items: ItemReport[]): string {
	const done = items.filter((i) => i.outcome === 'done');
	const sum = (k: string) => done.reduce((s, i) => s + (Number(i[k]) || 0), 0);
	const trashed = sum('movedToTrash');
	const lines = [`Freed ${human(sum('bytes') - trashed)} (measured change in free space: ${human(sum('freed'))}).`];
	if (trashed) lines.push(`Moved ${human(trashed)} to the Trash — not freed until the Trash is emptied.`);
	return lines.join('\n');
}

export async function run(args: string[]): Promise<Report> {
	const f = parseFlags(args, ['all', 'trash', 'permanent']);
	const mode = modeOf(f);
	const risk = f.get('risk');
	if (risk && !RISK_ORDER.includes(risk as Risk)) throw new Error(`--risk must be one of ${RISK_ORDER.join(', ')}`);
	if (f.has('trash') && f.has('permanent')) throw new Error('--trash and --permanent exclude each other');
	const scan = loadScan();
	if (!scan) return { command: 'clean', exit: 'refused', text: 'No saved scan — run `atlas disk scan` first.' };
	const picked = await select(scan.folders, f, mode);
	if (typeof picked === 'string') return { command: 'clean', exit: 'refused', text: picked };
	const rows = dropCovered(picked.rows);
	const toTrash = (r: FolderRow) => f.has('trash') || (r.risk === 'review' && !f.has('permanent'));
	const preview: Preview[] = [];
	const { go, out } = rows.length ? await gate(rows, mode, loadSettings(), f, toTrash, preview) : { go: [], out: [] };
	const items = [...picked.refused, ...out];
	if (f.has('dry-run')) {
		items.push(...go.map((r) => skip(r, `dry run — would ${toTrash(r) ? 'move to the Trash' : 'delete'} ${human(r.bytes)}`)));
		return { command: 'clean', items, data: { scanRanAt: scan.ranAt, preview }, exit: items.some((i) => i.outcome === 'refused') ? undefined : 'ok' };
	}
	const holder = go.length ? acquire('clean') : null;
	if (holder) return { command: 'clean', items: [...items, ...go.map((r) => refuse(r, `another job is running: ${holder.job} (pid ${holder.pid})`))] };
	trapCancel();
	for (const r of go) items.push(isCancelled() ? skip(r, 'cancelled') : await removeOne(r, toTrash(r)));
	forget(scan, items);
	return { command: 'clean', items, data: { scanRanAt: scan.ranAt }, text: items.length ? `${renderItems(items)}\n\n${summary(items)}` : undefined };
}
