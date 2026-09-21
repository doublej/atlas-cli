/**
 * One pass over a folder for its size and its newest file — the scan's measurement and the
 * re-check fingerprint before deleting. Allocated bytes like `du` (hardlinks once, links
 * not followed), measured in-process: as fast as `du` and it yields the mtime too.
 */
import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';

export interface Measure {
	bytes: number;
	/** Newest file mtime, ms since epoch (0 = no files). */
	newestMtime: number;
	/** The newest files, when asked for (newest first). */
	newest: { path: string; mtime: number }[];
}

export async function measure(dir: string, keepNewest = 0): Promise<Measure> {
	const m: Measure = { bytes: 0, newestMtime: 0, newest: [] };
	const seen = new Set<number>();
	const walk = async (d: string): Promise<void> => {
		let names: string[];
		try {
			names = await readdir(d);
		} catch {
			return;
		}
		const subdirs: string[] = [];
		// lstat in parallel (no fds held); descend one directory at a time so a deep tree never runs out of fds
		await Promise.all(
			names.map(async (n) => {
				const p = join(d, n);
				const s = await lstat(p).catch(() => null);
				if (!s) return;
				if (s.isDirectory()) subdirs.push(p);
				else if (s.nlink > 1) {
					if (seen.has(s.ino)) return;
					seen.add(s.ino);
				}
				m.bytes += s.blocks * 512;
				if (!s.isDirectory()) track(m, p, s.mtimeMs, keepNewest);
			})
		);
		for (const p of subdirs) await walk(p);
	};
	const root = await lstat(dir).catch(() => null);
	if (!root?.isDirectory()) return m;
	m.bytes += root.blocks * 512;
	await walk(dir);
	m.newestMtime = Math.floor(m.newestMtime);
	return m;
}

function track(m: Measure, path: string, mtime: number, keep: number): void {
	if (mtime > m.newestMtime) m.newestMtime = mtime;
	if (!keep) return;
	if (m.newest.length < keep || mtime > m.newest[m.newest.length - 1].mtime) {
		m.newest.push({ path, mtime });
		m.newest.sort((a, b) => b.mtime - a.mtime);
		m.newest.length = Math.min(m.newest.length, keep);
	}
}

/** Hash of the folder's top-level names: an entry added, removed or renamed changes it. */
export function listingHash(dir: string): string {
	let names: string[] = [];
	try {
		names = readdirSync(dir).sort();
	} catch {
		// unreadable → hash of nothing; the re-check then compares like with like
	}
	return createHash('sha1').update(names.join('\0')).digest('hex').slice(0, 16);
}

/** `fn` over `items`, at most `limit` at a time, results in input order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
	const out: R[] = new Array(items.length);
	let next = 0;
	const worker = async () => {
		while (next < items.length) {
			const i = next++;
			out[i] = await fn(items[i]);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return out;
}
