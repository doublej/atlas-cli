/**
 * `atlas disk archive (--eligible | <category/project>…) [--dry-run] [--unattended]
 *   [--include-dirty] [--keep-rebuildable] [--compression none|fast|strong|<1-19>] [--to DIR]
 *   [--confirmed [--confirm-dirty <category/project>]…]`
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseFlags, type Flags } from './flags';
import { loadSettings, type Settings } from './settings';
import { human } from './fsutil';
import * as oplog from './oplog';
import { approve, isCancelled, modeOf, policy, trapCancel, type Mode } from './approval';
import { acquire } from './lock';
import { mapLimit } from './archive-exec';
import { measureProject } from './analyze-project';
import { analyze, loadAnalysis } from './analyze';
import { ALWAYS_EXCLUDED, REBUILDABLE } from './archive-core';
import { archiveProject, type ArchiveOpts } from './archive-one';
import { listVersions } from './archive-list';
import { pruneArchives } from './archive-prune';
import { renderItems, type ItemReport, type Report } from './report';
import type { ProjectRow } from './types';

export function parseCompression(raw: string | undefined, fallback: number): number {
	if (raw === undefined) return fallback;
	const named: Record<string, number> = { none: 0, fast: 1, strong: 19 };
	const n = named[raw] ?? Number(raw);
	if (!Number.isInteger(n) || n < 0 || n > 19) throw new Error(`--compression is none, fast, strong or 1-19 (got '${raw}')`);
	return n;
}

async function targets(f: Flags, s: Settings): Promise<ProjectRow[]> {
	if (f.has('eligible')) {
		const a = loadAnalysis() ?? (await analyze(s, 0));
		const ids = a.projects.filter((p) => p.state === 'eligible' && existsSync(join(s.devRoot, p.id))).map((p) => p.id);
		return mapLimit(ids, 8, (id) => measureProject(id, join(s.devRoot, id), s));
	}
	return mapLimit(f.positional, 8, (id) => measureProject(id, join(s.devRoot, id), s));
}

/** Two levels, not in a skipped category. */
const outOfScope = (id: string, s: Settings): string | null =>
	id.split('/').length !== 2 ? 'not a <category>/<project> id' : s.skipCategories.includes(id.split('/')[0]) ? 'in a skipped category' : null;

const risky = (p: ProjectRow) => p.dirty || p.push === 'unpushed';

function planText(plan: ProjectRow[], o: ArchiveOpts): string {
	const total = plan.reduce((n, p) => n + p.bytes, 0);
	const rows = plan.map((p) => `  ${human(p.bytes).padStart(9)}  ${p.id}${risky(p) ? `  [${[p.dirty && 'uncommitted', p.push === 'unpushed' && 'unpushed'].filter(Boolean).join(', ')}]` : ''}`);
	return [`Archive plan → ${o.archiveDir} (compression ${o.compression || 'none'}):`, ...rows, `  frees up to ${human(total)} on this Mac (archives stay local until uploaded and evicted)`].join('\n');
}

/** A UI confirms each dirty project on its own: only the ids passed as `--confirm-dirty` go. */
const confirmedDirty = (id: string, f: Flags): true | { refuse: string } => (f.all('confirm-dirty').includes(id) ? true : { refuse: 'its own confirmation' });

/** Split the plan into approved projects and refused items, asking where the policy says to. */
async function approvePlan(plan: ProjectRow[], mode: Mode, s: Settings, f: Flags) {
	const refused: ItemReport[] = [];
	const whole = await approve(policy('archive', mode, s, f), `Archive ${plan.length} project(s) (${human(plan.reduce((n, p) => n + p.bytes, 0))})?`);
	if (whole !== true) return { go: [], refused: plan.map((p) => ({ item: p.id, outcome: 'refused' as const, needs: whole.refuse })) };
	const go: ProjectRow[] = [];
	for (const p of plan) {
		const ok = !risky(p) ? true : mode === 'interactive' && f.has('confirmed') ? confirmedDirty(p.id, f) : await approve(policy('archive-dirty', mode, s, f), `${p.id} has uncommitted or unpushed work. Archive it anyway?`);
		if (ok === true) go.push(p);
		else refused.push({ item: p.id, outcome: 'refused', reason: 'uncommitted or unpushed work', needs: ok.refuse });
	}
	return { go, refused };
}

export async function run(args: string[]): Promise<Report> {
	const f = parseFlags(args, ['eligible', 'include-dirty', 'keep-rebuildable']);
	const s = loadSettings();
	if (!f.has('eligible') && !f.positional.length) throw new Error('usage: atlas disk archive (--eligible | <category/project>…)');
	const o: ArchiveOpts = {
		devRoot: s.devRoot,
		archiveDir: f.get('to') ?? s.archiveDir,
		compression: parseCompression(f.get('compression'), s.compression),
		excludes: [...(f.has('keep-rebuildable') ? [] : REBUILDABLE), ...ALWAYS_EXCLUDED]
	};
	const bad = f.positional.flatMap((id) => {
		const why = outOfScope(id, s) ?? (existsSync(join(s.devRoot, id)) ? null : 'not found');
		return why ? [{ item: id, outcome: why === 'not found' ? ('skipped' as const) : ('refused' as const), reason: why }] : [];
	});
	f.positional.splice(0, f.positional.length, ...f.positional.filter((id) => !bad.some((b) => b.item === id)));
	const rows = (await targets(f, s)).sort((a, b) => b.bytes - a.bytes);
	const held: ItemReport[] = rows.flatMap((p) => {
		const op = oplog.isHeld(p.id);
		return op ? [{ item: p.id, outcome: 'refused' as const, reason: `held by interrupted operation ${op.start.id}`, needs: '`atlas disk recover`' }] : [];
	});
	const plan = rows.filter((p) => !held.some((h) => h.item === p.id));
	if (f.has('dry-run')) return { command: 'archive', exit: plan.length ? 'ok' : 'nothing', data: { plan: plan.map((p) => ({ ...p, dest: join(o.archiveDir, dirname(p.id)), freed: p.bytes })), refused: [...bad, ...held] }, text: [planText(plan, o), renderItems([...bad, ...held])].filter(Boolean).join('\n') };
	if (!plan.length) return { command: 'archive', items: [...bad, ...held] };
	const holder = acquire('archive');
	if (holder) return { command: 'archive', exit: 'refused', text: `Another job is running: ${holder.job} (pid ${holder.pid}, since ${holder.since}).` };
	const mode = modeOf(f);
	if (mode === 'interactive') console.log(planText(plan, o));
	const { go, refused } = await approvePlan(plan, mode, s, f);
	trapCancel();
	const items: ItemReport[] = [...bad, ...held, ...refused];
	for (const p of go) {
		if (isCancelled()) items.push({ item: p.id, outcome: 'skipped', reason: 'cancelled before it started' });
		else items.push(await archiveProject(p.id, p.bytes, o));
	}
	if (s.keepNewest && !isCancelled()) items.push(...(await pruneArchives(o.archiveDir, s.keepNewest, mode, s, f)));
	return summarize(items, o.archiveDir);
}

async function summarize(items: ItemReport[], archiveDir: string): Promise<Report> {
	const versions = await listVersions(archiveDir);
	const local = versions.reduce((n, v) => n + v.localBytes, 0);
	const cloud = versions.reduce((n, v) => n + (v.storage === 'uploaded' || v.storage === 'cloud' ? v.bytes : 0), 0);
	const lines = items.map((i) => (i.outcome === 'done' && 'bytesBefore' in i ? `${renderItems([i])}  ${human(i.bytesBefore as number)} → ${human(i.archiveBytes as number)} archive, freed ${human((i.freed as number) ?? 0)}` : renderItems([i])));
	const text = [...lines, '', `Archives: ${human(local)} still on this Mac · ${human(cloud)} already in the cloud`].join('\n');
	return { command: 'archive', items, data: { archiveLocalBytes: local, archiveCloudBytes: cloud }, text };
}
