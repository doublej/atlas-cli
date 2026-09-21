/** Removing one folder: the re-check against the scan, permanent delete, and Finder's Trash. */
import { existsSync, lstatSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { human } from './fsutil';
import { listingHash, measure } from './scan-measure';
import type { FolderRow } from './types';

/** Why the folder no longer matches its scan (size, newest file, contents list), or null. */
export async function recheck(row: FolderRow): Promise<string | null> {
	const st = lstatSync(row.path, { throwIfNoEntry: false });
	if (!st) return 'gone since the scan';
	if (!st.isDirectory()) return 'no longer a folder (a link or a file now)';
	if (listingHash(row.path) !== row.listingHash) return 'its contents list changed since the scan';
	const m = await measure(row.path);
	if (m.newestMtime !== row.newestMtime) return `its newest file changed since the scan (${new Date(m.newestMtime).toISOString()})`;
	if (m.bytes !== row.bytes) return `its size changed since the scan (${human(row.bytes)} → ${human(m.bytes)})`;
	return null;
}

/** A path we are willing to remove: absolute, not a root, no link on the way to it (the item itself may be one). */
export function assertRemovable(path: string): void {
	if (!path.startsWith('/') || path === '/' || path === homedir()) throw new Error(`refusing to remove ${path}`);
	const dir = dirname(path);
	if (realpathSync(dir) !== dir) throw new Error(`${path} passes through a link (${dir} is really ${realpathSync(dir)})`);
}

/**
 * Permanent delete. `rmSync` never follows links: a link inside is removed as a link and what
 * it points to is left alone (clean.test.ts checks this). The folder itself must not be a link.
 */
export function deletePermanent(path: string): void {
	assertRemovable(path);
	if (!lstatSync(path).isDirectory()) throw new Error(`${path} is not a folder (a link is never followed)`);
	rmSync(path, { recursive: true });
}

const utf16be = (s: string) => Buffer.from(s, 'utf16le').swap16();

/**
 * Move to the Trash through Finder, so Put Back works — Finder is what records the original
 * location (`ptbL`/`ptbN` in ~/.Trash/.DS_Store); `rename` into ~/.Trash or /usr/bin/trash don't
 * promise that. Returns the name it got in the Trash and whether that record was found.
 * Needs Automation permission for the terminal → Finder (asked once by macOS).
 */
export async function trashPath(path: string): Promise<{ trashedAs: string; putBack: boolean | 'unknown' }> {
	assertRemovable(path);
	const script = ['on run argv', 'tell application "Finder" to set t to delete (POSIX file (item 1 of argv) as alias)', 'return POSIX path of (t as alias)', 'end run'];
	const r = Bun.spawnSync(['osascript', ...script.flatMap((l) => ['-e', l]), path]);
	if (r.exitCode !== 0) throw new Error(`Finder could not move it to the Trash: ${r.stderr.toString().trim()}`);
	const trashedAs = r.stdout.toString().trim().replace(/\/$/, '');
	if (existsSync(path)) throw new Error('Finder reported success but the folder is still there');
	return { trashedAs, putBack: await putBackRecorded(trashedAs) };
}

/** Finder writes .DS_Store lazily: look for the Put Back record for up to 15s (seen: ~5s). */
async function putBackRecorded(trashedAs: string): Promise<boolean | 'unknown'> {
	const store = join(dirname(trashedAs), '.DS_Store');
	const needle = Buffer.concat([utf16be(basename(trashedAs)), Buffer.from('ptbL')]);
	for (let i = 0; i < 30; i++) {
		try {
			if (readFileSync(store).includes(needle)) return true;
		} catch {
			return 'unknown'; // ~/.Trash unreadable without Full Disk Access
		}
		await Bun.sleep(500);
	}
	return false;
}
