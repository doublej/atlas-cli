/** `--confirmed` resolves a confirmation without a terminal and changes nothing else in the policy. */
import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'atlas-disk-confirmed-'));
process.env.ATLAS_DISK_HOME = join(root, 'state'); // before any disk module reads it
const devRoot = join(root, 'dev');

const { approve, modeOf, policy } = await import('./approval');
const { parseFlags } = await import('./flags');
const { DEFAULTS, saveSettings } = await import('./settings');
const { run: archive } = await import('./archive');
const { release } = await import('./lock');

saveSettings({ ...DEFAULTS, devRoot, archiveDir: join(root, 'archive'), keepNewest: null });
afterAll(() => rmSync(root, { recursive: true, force: true }));

const git = (dir: string, ...args: string[]) => Bun.spawnSync(['git', '-C', dir, ...args], { env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
function makeRepo(id: string, dirty: boolean): void {
	const dir = join(devRoot, id);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, 'main.ts'), 'export {};\n');
	git(dir, 'init', '-q');
	git(dir, 'add', '.');
	git(dir, 'commit', '-qm', 'init');
	if (dirty) writeFileSync(join(dir, 'main.ts'), 'export const x = 1;\n');
}

test('policy: unclassified folders and the Rust sweep (off) are refused even when confirmed', async () => {
	const f = parseFlags(['--confirmed']);
	const mode = modeOf(f);
	expect(mode).toBe('interactive');
	expect(policy('clean-unclassified', mode, DEFAULTS, f)).toMatchObject({ refuse: expect.any(String) });
	expect(policy('rust-sweep', mode, { ...DEFAULTS, rustSweep: false }, f)).toMatchObject({ refuse: expect.any(String) });
	expect(await approve(policy('delete-archive', mode, DEFAULTS, f), '?')).toBe(true);
	modeOf(parseFlags([]));
	expect(await approve('confirm', '?')).toMatchObject({ refuse: expect.any(String) }); // no terminal, not confirmed
});

test('a dirty project is archived only when it has its own --confirm-dirty', async () => {
	makeRepo('web/tidy', false);
	makeRepo('web/messy', true);
	const first = await archive(['web/tidy', 'web/messy', '--confirmed']);
	release();
	expect(first.items?.find((i) => i.item === 'web/tidy')?.outcome).toBe('done');
	expect(first.items?.find((i) => i.item === 'web/messy')).toMatchObject({ outcome: 'refused', needs: 'its own confirmation' });
	const second = await archive(['web/messy', '--confirmed', '--confirm-dirty', 'web/messy']);
	release();
	expect(second.items?.find((i) => i.item === 'web/messy')?.outcome).toBe('done');
}, 60_000);
