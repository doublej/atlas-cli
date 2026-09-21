/** `atlas disk restore <category/project | version-id>… [--keep-archive] [--dry-run] [--unattended]` */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseFlags } from './flags';
import { loadSettings } from './settings';
import { human } from './fsutil';
import * as oplog from './oplog';
import { approve, isCancelled, modeOf, policy, trapCancel } from './approval';
import { acquire } from './lock';
import { listVersions, resolveVersion } from './archive-list';
import { restoreVersion } from './restore-one';
import { renderItems, type ItemReport, type Report } from './report';
import type { ArchiveVersion } from './types';

/** Resolve refs to versions; unknown refs, held projects and existing folders become report items. */
function resolveAll(all: ArchiveVersion[], refs: string[], devRoot: string) {
	const plan: ArchiveVersion[] = [];
	const items: ItemReport[] = [];
	for (const ref of refs) {
		const v = resolveVersion(all, ref);
		const held = v && oplog.isHeld(v.project);
		if (!v) items.push({ item: ref, outcome: 'skipped', reason: 'no such archive' });
		else if (held) items.push({ item: v.id, outcome: 'refused', reason: `held by interrupted operation ${held.start.id}`, needs: '`atlas disk recover`' });
		else if (existsSync(join(devRoot, v.project))) items.push({ item: v.id, outcome: 'refused', reason: `${join(devRoot, v.project)} already exists — refusing to overwrite` });
		else plan.push(v);
	}
	return { plan, items };
}

const planText = (plan: ArchiveVersion[], devRoot: string, keep: boolean) =>
	[
		'Restore plan:',
		...plan.map((v) => `  ${human(v.bytes).padStart(9)}  ${v.id} → ${join(devRoot, v.project)}${v.storage === 'cloud' ? '  (download first)' : ''}${v.verified ? '' : `  [not verified: ${v.verifyNote}]`}`),
		keep ? '  archives are kept' : '  archive files are deleted after a successful restore'
	].join('\n');

export async function run(args: string[]): Promise<Report> {
	const f = parseFlags(args, ['keep-archive']);
	const s = loadSettings();
	if (!f.positional.length) throw new Error('usage: atlas disk restore <category/project | version-id>…');
	const all = await listVersions(s.archiveDir);
	const projects = f.positional.map((r) => resolveVersion(all, r)?.project).filter(Boolean);
	const twice = projects.find((p, i) => projects.indexOf(p) !== i);
	if (twice) return { command: 'restore', exit: 'refused', text: `Refused: ${twice} is selected twice — pick one version per project.` };
	const { plan, items } = resolveAll(all, f.positional, s.devRoot);
	const keep = f.has('keep-archive');
	if (f.has('dry-run')) return { command: 'restore', exit: plan.length ? 'ok' : 'nothing', data: { plan, skipped: items }, text: [planText(plan, s.devRoot, keep), renderItems(items)].filter(Boolean).join('\n') };
	if (!plan.length) return { command: 'restore', items };
	const holder = acquire('restore');
	if (holder) return { command: 'restore', exit: 'refused', text: `Another job is running: ${holder.job} (pid ${holder.pid}, since ${holder.since}).` };
	const mode = modeOf(f);
	if (mode === 'interactive') console.log(planText(plan, s.devRoot, keep));
	const ok = await approve(policy('restore', mode, s, f), `Restore ${plan.length} project(s)?`);
	if (ok !== true) return { command: 'restore', items: [...items, ...plan.map((v) => ({ item: v.id, outcome: 'refused' as const, needs: ok.refuse }))] };
	trapCancel();
	for (const v of plan) items.push(isCancelled() ? { item: v.id, outcome: 'skipped', reason: 'cancelled before it started' } : await restoreVersion(v, s.devRoot, keep));
	return { command: 'restore', items };
}
