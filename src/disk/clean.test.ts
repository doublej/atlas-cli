import { beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

setDefaultTimeout(60_000); // each scan runs one system-wide lsof (3-10s)
// Everything runs on fixtures under a scratch folder; state goes there too (set before the imports read it).
const BASE = '/private/tmp/claude-501/disk-agent-b';
mkdirSync(BASE, { recursive: true });
const TMP = mkdtempSync(join(BASE, 'test-'));
process.env.ATLAS_DISK_HOME = join(TMP, 'state');

const { finalize, buildScan } = await import('./scan');
const { run: clean, dropCovered } = await import('./clean');
const { deletePermanent } = await import('./clean-delete');
const { warnReason } = await import('./scan-notify');
const { run: manual } = await import('./manual');
const { saveSettings, loadSettings, statePath } = await import('./settings');
const { writeJsonAtomic } = await import('./fsutil');
const { release } = await import('./lock');
import type { FolderRow } from './types';

const MB = 1024 * 1024;
const row = (path: string, bytes: number, risk: FolderRow['risk'] = 'rebuildable'): FolderRow => ({
	path, bytes, risk, why: 'test', restore: 'test', inUse: null, newestMtime: 0, listingHash: '', nested: false
});
function file(path: string, bytes = 1024): void {
	mkdirSync(join(path, '..'), { recursive: true });
	writeFileSync(path, Buffer.alloc(bytes, 1));
}
/** A home-like fixture: one JS project with node_modules and dist, one Rust project with target. */
function fixture(): string {
	const root = mkdtempSync(join(TMP, 'home-'));
	file(join(root, 'dev/web/app/package.json'));
	file(join(root, 'dev/web/app/bun.lock'));
	file(join(root, 'dev/web/app/node_modules/pkg/index.js'), 64 * 1024);
	file(join(root, 'dev/web/app/dist/app.js'), 64 * 1024);
	file(join(root, 'dev/rust/tool/Cargo.toml'));
	file(join(root, 'dev/rust/tool/target/debug/tool'), 64 * 1024);
	file(join(root, 'dev/misc/dist/stray.js'), 64 * 1024); // no manifest next to it: unclassified
	return root;
}
async function scanFixture(root: string) {
	const scan = await buildScan(root, 0);
	writeJsonAtomic(statePath('scan.json'), scan);
	return scan;
}
async function cleanRun(args: string[]) {
	const r = await clean(args);
	release();
	return r;
}

beforeEach(() => saveSettings({ ...loadSettings(), autoCleanRebuildable: false }));

describe('scan', () => {
	test('nested rows count once in the total; a selected child of a selected parent is dropped', () => {
		const { folders, totalBytes } = finalize([row('/a', 10 * MB), row('/a/b', 4 * MB), row('/ab', 1 * MB)]);
		expect(totalBytes).toBe(11 * MB);
		expect(folders.find((f) => f.path === '/a/b')?.nested).toBe(true);
		expect(folders.find((f) => f.path === '/ab')?.nested).toBe(false);
		expect(dropCovered([row('/a', 1), row('/a/b', 1), row('/ab', 1)]).map((r) => r.path)).toEqual(['/a', '/ab']);
	});

	test('a parent is as risky as its riskiest listed child', () => {
		const { folders } = finalize([row('/c', 10 * MB, 'rebuildable'), row('/c/sim', 4 * MB, 'review')]);
		expect(folders.find((f) => f.path === '/c')?.risk).toBe('review');
	});

	test('classifies by what sits next to a hit; unclassified is never listed', async () => {
		const root = fixture();
		const scan = await scanFixture(root);
		const by = (p: string) => scan.folders.find((f) => f.path === join(root, p));
		expect(by('dev/web/app/node_modules')).toMatchObject({ risk: 'reinstallable', restore: 'bun install' });
		expect(by('dev/web/app/dist')?.risk).toBe('rebuildable');
		expect(by('dev/rust/tool/target')?.why).toBe('target next to Cargo.toml');
		expect(by('dev/misc/dist')).toBeUndefined();
	});

	test('a build folder holding another project is review-level', async () => {
		const root = fixture();
		file(join(root, 'dev/web/app/dist/vendored/.git/HEAD'));
		const scan = await scanFixture(root);
		const dist = scan.folders.find((f) => f.path === join(root, 'dev/web/app/dist'));
		expect(dist?.risk).toBe('review');
		expect(dist?.why).toContain('contains another project');
	});
});

describe('clean', () => {
	test('a folder that changed since the scan is skipped; an unchanged one is deleted', async () => {
		const root = fixture();
		await scanFixture(root);
		saveSettings({ ...loadSettings(), autoCleanRebuildable: true });
		file(join(root, 'dev/web/app/dist/new.js'));
		const target = join(root, 'dev/rust/tool/target');
		const r = await cleanRun([join(root, 'dev/web/app/dist'), target, '--unattended']);
		expect(r.items?.find((i) => i.item.endsWith('dist'))).toMatchObject({ outcome: 'skipped' });
		expect(r.items?.find((i) => i.item.endsWith('dist'))?.reason).toContain('changed since the scan');
		expect(r.items?.find((i) => i.item === target)?.outcome).toBe('done');
		expect(existsSync(target)).toBe(false);
		expect(existsSync(join(root, 'dev/rust/tool/Cargo.toml'))).toBe(true);
	});

	test('unattended: only rebuildable, and only with the standing rule', async () => {
		const root = fixture();
		file(join(root, 'dev/web/app/dist/vendored/.git/HEAD')); // → review
		await scanFixture(root);
		const all = ['--all', '--unattended', '--dry-run'];
		const outcome = (r: Awaited<ReturnType<typeof cleanRun>>, end: string) => r.items?.find((i) => i.item.endsWith(end));
		let r = await cleanRun(all);
		expect(outcome(r, 'target')).toMatchObject({ outcome: 'refused' });
		expect(outcome(r, 'target')?.needs).toContain('autoCleanRebuildable');
		expect(outcome(r, 'node_modules')?.outcome).toBe('refused');
		expect(outcome(r, 'dist')?.outcome).toBe('refused');
		saveSettings({ ...loadSettings(), autoCleanRebuildable: true });
		r = await cleanRun(all);
		expect(outcome(r, 'target')?.outcome).toBe('skipped'); // dry run: allowed, not done
		expect(outcome(r, 'node_modules')?.outcome).toBe('refused');
		expect(outcome(r, 'dist')?.outcome).toBe('refused');
		expect((await cleanRun([...all, '--scheduled'])).items?.every((i) => i.outcome === 'refused')).toBe(true);
	});

	test('permanent delete never follows a link out of the folder', () => {
		const outside = join(TMP, 'outside');
		file(join(outside, 'keep.txt'));
		const doomed = join(TMP, 'doomed');
		mkdirSync(doomed);
		symlinkSync(outside, join(doomed, 'link-dir'));
		symlinkSync(join(outside, 'keep.txt'), join(doomed, 'link-file'));
		deletePermanent(doomed);
		expect(existsSync(doomed)).toBe(false);
		expect(existsSync(join(outside, 'keep.txt'))).toBe(true);
		symlinkSync(outside, join(TMP, 'link-to-outside'));
		expect(() => deletePermanent(join(TMP, 'link-to-outside'))).toThrow();
		expect(existsSync(join(outside, 'keep.txt'))).toBe(true);
	});
});

describe('notify and manual steps', () => {
	test('warn at the total limit or on growth past the growth limit', () => {
		const GB = 1024 ** 3;
		const s = { notifyTotalGB: 50, notifyGrowthGB: 10 };
		expect(warnReason(50 * GB, null, s)).not.toBeNull();
		expect(warnReason(49 * GB, null, s)).toBeNull();
		expect(warnReason(30 * GB, 19 * GB, s)).not.toBeNull();
		expect(warnReason(30 * GB, 20 * GB, s)).toBeNull();
	});

	test('log move never overwrites', async () => {
		file(join(TMP, 'm/a.txt'));
		file(join(TMP, 'm/b.txt'), 7);
		const refused = await manual(['move', join(TMP, 'm/a.txt'), join(TMP, 'm/b.txt')]);
		release();
		expect(refused.items?.[0].outcome).toBe('refused');
		const moved = await manual(['move', join(TMP, 'm/a.txt'), join(TMP, 'm/sub/c.txt')]);
		release();
		expect(moved.items?.[0].outcome).toBe('done');
		expect(existsSync(join(TMP, 'm/sub/c.txt'))).toBe(true);
	});
});

process.on('exit', () => rmSync(TMP, { recursive: true, force: true }));

describe('clean --confirmed (a UI showed the plan)', () => {
	test('--dry-run --json carries each folder’s contents and newest files', async () => {
		const root = fixture();
		await scanFixture(root);
		const dist = join(root, 'dev/web/app/dist');
		const r = await cleanRun([dist, '--dry-run', '--json', '--confirmed']);
		const preview = (r.data as { preview: { path: string; entries: string[]; newest: { path: string }[] }[] }).preview;
		expect(preview).toEqual([{ path: dist, entries: ['app.js'], newest: [expect.objectContaining({ path: 'app.js' })] }]);
		expect(existsSync(dist)).toBe(true);
	});

	test('deletes without a terminal, but an unclassified folder is still refused', async () => {
		const root = fixture();
		await scanFixture(root);
		const dist = join(root, 'dev/web/app/dist');
		const stray = join(root, 'dev/misc/dist');
		const r = await cleanRun([dist, stray, '--confirmed']);
		expect(r.items?.find((i) => i.item === dist)?.outcome).toBe('done');
		expect(r.items?.find((i) => i.item === stray)?.outcome).toBe('refused');
		expect(existsSync(dist)).toBe(false);
		expect(existsSync(stray)).toBe(true);
	});
});
