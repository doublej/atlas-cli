/**
 * `atlas disk scan [--min-size MB] [--risk R] [--cached] [--notify] [--scheduled] [--json]` —
 * rebuildable folders under the home folder, largest first, each with its risk, why it
 * matched, how to get it back and whether something uses it. Read-only; saved to `scan.json`.
 */
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseFlags } from './flags';
import { ago, human, writeJsonAtomic } from './fsutil';
import type { Report } from './report';
import { classify, RISK_ORDER, riskMax, siblingsOf, SINGLETONS, type Rule } from './scan-rules';
import { listingHash, mapLimit, measure } from './scan-measure';
import { findHits, foreignReason, inUseChecker } from './scan-walk';
import { notify, warnReason } from './scan-notify';
import { loadSettings, statePath } from './settings';
import type { FolderRow, Risk, Scan } from './types';

/** scan.json: the Scan plus the total before it, for growth. */
export interface SavedScan extends Scan {
	previous?: { ranAt: string; totalBytes: number };
}

/** `ATLAS_DISK_SCAN_ROOT` points the scan at a fixture tree (tests); default the home folder. */
export const scanRoot = (): string => process.env.ATLAS_DISK_SCAN_ROOT ?? homedir();

export function loadScan(): SavedScan | null {
	const file = statePath('scan.json');
	return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as SavedScan) : null;
}

const isInside = (child: string, parent: string) => child.startsWith(`${parent}/`);

/** Nested flags, a parent's risk raised to its riskiest listed child, the deduped total. Largest first. */
export function finalize(rows: FolderRow[]): { folders: FolderRow[]; totalBytes: number } {
	const folders = rows.map((r) => ({ ...r }));
	for (const r of folders) {
		r.nested = folders.some((p) => isInside(r.path, p.path));
		for (const c of folders.filter((c) => isInside(c.path, r.path))) {
			if (riskMax(r.risk, c.risk) !== r.risk) {
				r.risk = c.risk;
				r.why += `; holds ${c.risk}-level ${c.path.slice(r.path.length + 1)}`;
			}
		}
	}
	folders.sort((a, b) => b.bytes - a.bytes);
	return { folders, totalBytes: folders.filter((f) => !f.nested).reduce((s, f) => s + f.bytes, 0) };
}

interface Candidate {
	path: string;
	rule: Rule;
	/** The project a pattern hit belongs to; null for singletons. */
	project: string | null;
}

function candidates(root: string): Candidate[] {
	const hits = findHits(root).flatMap((path) => {
		const rule = classify(path, siblingsOf(path));
		return rule ? [{ path, rule, project: dirname(path) }] : [];
	});
	const singles = Object.entries(SINGLETONS)
		.map(([rel, rule]) => ({ path: join(root, rel), rule, project: null }))
		.filter((c) => lstatSync(c.path, { throwIfNoEntry: false })?.isDirectory());
	return [...hits, ...singles];
}

export async function buildScan(root: string, minMB: number): Promise<Scan> {
	const inUse = inUseChecker(root);
	const measured = await mapLimit(candidates(root), 8, async (c) => ({ c, m: await measure(c.path) }));
	const rows: FolderRow[] = measured
		.filter(({ m }) => m.bytes >= minMB * 1024 * 1024)
		.map(({ c, m }) => {
			const foreign = c.project ? foreignReason(c.path) : null;
			return {
				path: c.path,
				bytes: m.bytes,
				risk: foreign ? 'review' : c.rule.risk,
				why: foreign ? `${c.rule.why}, but ${foreign}` : c.rule.why,
				restore: c.rule.restore,
				inUse: inUse(c.path, c.project),
				newestMtime: m.newestMtime,
				listingHash: listingHash(c.path),
				nested: false
			};
		});
	return { ranAt: new Date().toISOString(), minMB, ...finalize(rows) };
}

const short = (p: string) => p.replace(homedir(), '~');

function render(scan: SavedScan, view: { folders: FolderRow[]; totalBytes: number }): string {
	const prev = scan.previous;
	const growth = prev ? ` · ${scan.totalBytes >= prev.totalBytes ? '+' : ''}${human(scan.totalBytes - prev.totalBytes)} since ${ago(prev.ranAt)}` : '';
	const head = `Scan ran ${ago(scan.ranAt)} · ${view.folders.length} folder(s) ≥ ${scan.minMB} MB · ${human(view.totalBytes)} reclaimable (deduped)${growth}`;
	const lines = view.folders.map((f) => {
		const flags = `${f.nested ? ' [nested]' : ''}${f.inUse ? ` [in use: ${f.inUse}]` : ''}`;
		return `${human(f.bytes).padStart(9)}  ${f.risk.padEnd(13)} ${short(f.path)}${flags}\n${' '.repeat(26)}${f.why} · restore: ${f.restore}`;
	});
	return [head, '', ...lines, '', 'Next: atlas disk clean [--risk R]'].join('\n');
}

export async function run(args: string[]): Promise<Report> {
	const f = parseFlags(args, ['cached', 'notify']);
	const risk = f.get('risk') as Risk | undefined;
	if (risk && !RISK_ORDER.includes(risk)) throw new Error(`--risk must be one of ${RISK_ORDER.join(', ')}`);
	const settings = loadSettings();
	const old = loadScan();
	let scan: SavedScan;
	if (f.has('cached')) {
		if (!old) return { command: 'scan', exit: 'nothing', text: 'No scan yet — run `atlas disk scan`.' };
		scan = old;
	} else {
		scan = await buildScan(scanRoot(), f.num('min-size') ?? settings.scanMinMB);
		if (old) scan.previous = { ranAt: old.ranAt, totalBytes: old.totalBytes };
		writeJsonAtomic(statePath('scan.json'), scan);
	}
	const view = finalize(risk ? scan.folders.filter((r) => r.risk === risk) : scan.folders);
	let notified: string | null = null;
	if (f.has('notify') && !f.has('cached')) {
		notified = warnReason(scan.totalBytes, scan.previous?.totalBytes ?? null, settings);
		if (notified) notify(notified, scan);
	}
	return {
		command: 'scan',
		exit: view.folders.length ? 'ok' : 'nothing',
		data: { ...scan, ...view, notified },
		text: view.folders.length ? render(scan, view) : `Scan ran ${ago(scan.ranAt)}: nothing ≥ ${scan.minMB} MB${risk ? ` at risk ${risk}` : ''}.`
	};
}
