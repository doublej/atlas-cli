/** Archive → verify → remove → restore → recover, on a throwaway fixture (never real data). */
import { afterAll, describe, expect, test } from 'bun:test';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'atlas-disk-test-'));
process.env.ATLAS_DISK_HOME = join(root, 'state'); // before any disk module reads it
const devRoot = join(root, 'dev');
const archiveDir = join(root, 'archive');

const oplog = await import('./oplog');
const { archiveProject } = await import('./archive-one');
const { listVersions, pruneCandidates } = await import('./archive-list');
const { readManifest, sourceMtree, REBUILDABLE } = await import('./archive-core');
const { restoreVersion } = await import('./restore-one');
const { recoverOne } = await import('./recover-actions');

const opts = { devRoot, archiveDir, compression: 1, excludes: [...REBUILDABLE, '.DS_Store'] };

function makeProject(id: string, bigMB = 0): string {
	const dir = join(devRoot, id);
	mkdirSync(join(dir, 'src'), { recursive: true });
	mkdirSync(join(dir, 'node_modules', 'dep'), { recursive: true });
	writeFileSync(join(dir, 'src', 'main.ts'), 'export const x = 1;\n');
	writeFileSync(join(dir, 'node_modules', 'dep', 'index.js'), 'rebuildable');
	if (bigMB) writeFileSync(join(dir, 'big.bin'), crypto.getRandomValues(new Uint8Array(bigMB * 1024 * 1024)).map((b, i) => (i % 7 ? b : 0)));
	return dir;
}

const versionOf = async (id: string) => (await listVersions(archiveDir)).find((v) => v.project === id)!;

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('archive → restore', () => {
	test('a verified archive removes the project; restore brings back the same files', async () => {
		const dir = makeProject('web/alpha');
		const before = await sourceMtree(dir, opts.excludes);
		const r = await archiveProject('web/alpha', 1, opts);
		expect(r.outcome).toBe('done');
		expect(existsSync(dir)).toBe(false);
		const v = await versionOf('web/alpha');
		expect(v.verified).toBe(true);
		expect(readManifest(v.file)!.leftOut).toEqual(['node_modules']);
		const back = await restoreVersion(v, devRoot, false);
		expect(back.outcome).toBe('done');
		expect(await sourceMtree(dir, [])).toBe(before);
		expect(existsSync(v.file)).toBe(false);
	});

	test('restore never overwrites an existing folder', async () => {
		makeProject('web/beta');
		await archiveProject('web/beta', 1, opts);
		makeProject('web/beta');
		const r = await restoreVersion(await versionOf('web/beta'), devRoot, false);
		expect(r.outcome).toBe('refused');
		expect(existsSync((await versionOf('web/beta')).file)).toBe(true);
	});

	test('a file changed during archiving keeps the project and marks the archive unverified', async () => {
		const dir = makeProject('web/busy', 40);
		const running = archiveProject('web/busy', 1, { ...opts, compression: 19 });
		const writing = () => oplog.operations().some((o) => o.start.item === 'web/busy' && o.steps.some((st) => st.phase === 'writing'));
		while (!writing()) await Bun.sleep(10);
		appendFileSync(join(dir, 'src', 'main.ts'), '// edited\n');
		const r = await running;
		expect(r.outcome).toBe('skipped');
		expect(existsSync(dir)).toBe(true);
		const v = await versionOf('web/busy');
		expect(v.verified).toBe(false);
		expect(v.verifyNote).toBe('changed during archiving');
	}, 60_000);
});

describe('recover', () => {
	/** A verified archive plus the project, with an archive op that died while removing it. */
	async function interruptedRemoval(id: string) {
		const dir = makeProject(id);
		await archiveProject(id, 1, opts);
		const v = await versionOf(id);
		await restoreVersion(v, devRoot, true);
		const opId = oplog.start({ op: 'archive', item: id, target: v.file, details: { source: dir } });
		oplog.step(opId, 'removing');
		rmSync(join(dir, 'src'), { recursive: true }); // half removed
		return { dir, v, op: oplog.pending().find((o) => o.start.id === opId)! };
	}

	test('undo restores a half-removed project from its verified archive', async () => {
		const { dir, op } = await interruptedRemoval('web/gamma');
		expect((await recoverOne(op, 'undo')).outcome).toBe('done');
		expect(existsSync(join(dir, 'src', 'main.ts'))).toBe(true);
		expect(oplog.pending().some((o) => o.start.id === op.start.id)).toBe(false);
	});

	test('finish completes the removal after re-checking the archive', async () => {
		const { dir, v, op } = await interruptedRemoval('web/delta');
		expect((await recoverOne(op, 'finish')).outcome).toBe('done');
		expect(existsSync(dir)).toBe(false);
		expect(existsSync(v.file)).toBe(true);
	});

	test('undo of an interrupted restore removes the temp folder, archive stays', async () => {
		makeProject('web/eps');
		await archiveProject('web/eps', 1, opts);
		const v = await versionOf('web/eps');
		const tmp = join(devRoot, 'web', '.atlas-restore-test');
		mkdirSync(join(tmp, 'eps'), { recursive: true });
		const opId = oplog.start({ op: 'restore', item: 'web/eps', target: join(devRoot, 'web/eps'), details: { file: v.file, tmp, keepArchive: false } });
		oplog.step(opId, 'unpacking');
		await recoverOne(oplog.pending().find((o) => o.start.id === opId)!, 'undo');
		expect(existsSync(tmp)).toBe(false);
		expect(existsSync(v.file)).toBe(true);
	});
});

test('archive refuses an id that climbs out of devRoot', async () => {
	const { saveSettings, DEFAULTS } = await import('./settings');
	const { run } = await import('./archive');
	saveSettings({ ...DEFAULTS, devRoot, archiveDir });
	mkdirSync(join(root, 'outside'), { recursive: true }); // join(devRoot, '../outside') exists
	const r = await run(['../outside', 'web/..', '--dry-run']);
	const data = r.data as { plan: unknown[]; refused: { item: string; outcome: string }[] };
	expect(data.plan).toEqual([]);
	expect(data.refused.map((i) => [i.item, i.outcome])).toEqual([['../outside', 'refused'], ['web/..', 'refused']]);
});

test('prune never removes the only version of a project', () => {
	const v = (project: string, version: string) => ({ project, version, id: `${project}@${version}` }) as never;
	const doomed = pruneCandidates([v('a/x', '2'), v('a/x', '1'), v('b/y', '1')], 0);
	expect(doomed.map((d: { id: string }) => d.id)).toEqual(['a/x@1']);
});
