/** Small filesystem helpers shared by every `atlas disk` module. */
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, statfsSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

/** tmp + fsync + rename: a reader never sees half a file. */
export function writeJsonAtomic(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.tmp`;
	const fd = openSync(tmp, 'w');
	writeSync(fd, JSON.stringify(value, null, '\t'));
	fsyncSync(fd);
	closeSync(fd);
	renameSync(tmp, path);
}

/** Bytes free to this user on the volume holding `path`. */
export function freeBytes(path: string): number {
	const s = statfsSync(path);
	return s.bavail * s.bsize;
}

/** Allocated size of a tree in bytes (`du -sk`, never follows links). 0 when unreadable. */
export function duBytes(path: string): number {
	const r = Bun.spawnSync(['du', '-sk', path], { stderr: 'ignore' });
	return Number(r.stdout.toString().split('\t')[0] || 0) * 1024;
}

export function human(bytes: number): string {
	const units = ['B', 'KB', 'MB', 'GB', 'TB'];
	let n = Math.abs(bytes);
	let i = 0;
	while (n >= 1024 && i < units.length - 1) {
		n /= 1024;
		i++;
	}
	return `${bytes < 0 ? '-' : ''}${n.toFixed(i < 2 ? 0 : 1)} ${units[i]}`;
}

/** "3h ago" style age of an ISO timestamp. */
export function ago(iso: string, now = Date.now()): string {
	const s = Math.max(0, (now - Date.parse(iso)) / 1000);
	if (s < 90) return `${Math.round(s)}s ago`;
	if (s < 5400) return `${Math.round(s / 60)}m ago`;
	if (s < 129600) return `${Math.round(s / 3600)}h ago`;
	return `${Math.round(s / 86400)}d ago`;
}
