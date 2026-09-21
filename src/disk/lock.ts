/**
 * One job that changes files at a time. `job.lock` is created exclusively and holds the
 * owner's pid; a lock whose pid is gone is stale (crash, power loss) and is taken over —
 * whatever that job left half-done is already `pending` in the operation log.
 */
import { closeSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { ensureStateDir, statePath } from './settings';
import { RUN_ID } from './oplog';

export interface LockInfo {
	pid: number;
	run: string;
	job: string;
	since: string;
}

const LOCK = () => statePath('job.lock');

const alive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === 'EPERM';
	}
};

export function currentLock(): LockInfo | null {
	try {
		const info = JSON.parse(readFileSync(LOCK(), 'utf8')) as LockInfo;
		return alive(info.pid) ? info : null;
	} catch {
		return null;
	}
}

/** Take the lock or return the job that holds it. Released automatically on exit. */
export function acquire(job: string): LockInfo | null {
	ensureStateDir();
	const holder = currentLock();
	if (holder && holder.pid !== process.pid) return holder;
	if (!holder) rmSync(LOCK(), { force: true });
	let fd: number;
	try {
		fd = openSync(LOCK(), 'wx');
	} catch {
		return currentLock() ?? { pid: 0, run: '?', job: 'unknown', since: '' };
	}
	writeSync(fd, JSON.stringify({ pid: process.pid, run: RUN_ID, job, since: new Date().toISOString() }));
	closeSync(fd);
	process.on('exit', release);
	return null;
}

export function release(): void {
	const holder = currentLock();
	if (holder?.pid === process.pid) rmSync(LOCK(), { force: true });
}
