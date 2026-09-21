/**
 * Measure one project: size (du), edit age (newest file that counts as an edit), and git
 * state (read-only, no network — push state compares with the local remote-tracking refs).
 */
import { existsSync } from 'node:fs';
import { exec } from './archive-exec';
import type { ProjectRow, PushState } from './types';

/** Folders whose files never count as edits: deps, build output, VCS, tool state. From analyze.sh. */
export const NOT_EDIT_DIRS = [
	'.git', 'node_modules', '.svelte-kit', 'venv', '.venv', '__pycache__', 'target', '.next', 'dist',
	'.build', '.cache', 'build', '.beads', '.claude', '.DerivedData', 'DerivedData', '.idea', '.vscode',
	'.turbo', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.gradle', '.wrangler', '.playwright-mcp'
];
/** Files that never count as edits: lock files, logs, Finder metadata, atlas's own `.atlas` port record. */
export const NOT_EDIT_FILES = [
	'.DS_Store', '*.lockb', '*.lock', '*.log', 'package-lock.json', 'pnpm-lock.yaml', 'go.sum', 'Package.resolved', '.atlas'
];

const or = (flag: string, names: string[]) => names.flatMap((n, i) => (i ? ['-o', flag, n] : [flag, n]));

/** Newest edit file as [mtime seconds, path relative to the project], or null. */
export async function newestEdit(dir: string): Promise<[number, string] | null> {
	const find = ['find', dir, '(', ...or('-name', NOT_EDIT_DIRS), ')', '-prune', '-o', '-type', 'f'];
	const notFiles = NOT_EDIT_FILES.flatMap((n) => ['!', '-name', n]);
	const script = '"$@" -exec stat -f "%m%t%N" {} + 2>/dev/null | sort -rn | head -1';
	const r = await exec(['sh', '-c', script, 'sh', ...find, ...notFiles]);
	const [mtime, path] = r.out.trim().split('\t');
	return path ? [Number(mtime), path.slice(dir.length + 1)] : null;
}

export async function duBytesAsync(path: string): Promise<number> {
	const r = await exec(['du', '-sk', path]);
	return Number(r.out.split('\t')[0] || 0) * 1024;
}

const git = async (dir: string, ...args: string[]) => exec(['git', '-C', dir, ...args]);

export interface GitState {
	dirty: boolean;
	push: PushState;
	lastCommit: string | null;
}

/** Only a project that is itself a repo (`.git` dir or worktree file) has a git state. */
export async function gitState(dir: string): Promise<GitState> {
	if (!existsSync(`${dir}/.git`)) return { dirty: false, push: 'no-git', lastCommit: null };
	const [status, remotes, ahead, log] = await Promise.all([
		git(dir, 'status', '--porcelain'),
		git(dir, 'remote'),
		git(dir, 'rev-list', '--count', '--branches', '--not', '--remotes'),
		git(dir, 'log', '-1', '--format=%cI')
	]);
	const push: PushState =
		!remotes.out.trim() || ahead.code !== 0 ? 'unknown' : Number(ahead.out.trim()) > 0 ? 'unpushed' : 'pushed';
	return { dirty: status.code === 0 && status.out.trim() !== '', push, lastCommit: log.code === 0 ? log.out.trim() || null : null };
}

export interface Thresholds {
	activeDays: number;
	archiveAgeDays: number;
	archiveMinMB: number;
}

export function stateOf(bytes: number, ageDays: number | null, t: Thresholds): ProjectRow['state'] {
	if (ageDays === null) return 'inactive';
	if (ageDays >= t.archiveAgeDays && bytes >= t.archiveMinMB * 1024 * 1024) return 'eligible';
	return ageDays <= t.activeDays ? 'active' : 'inactive';
}

/** Full row for one project; `bytes` passed in when already measured. */
export async function measureProject(id: string, path: string, t: Thresholds, bytes?: number): Promise<ProjectRow> {
	const [size, edit, g] = await Promise.all([bytes ?? duBytesAsync(path), newestEdit(path), gitState(path)]);
	const ageDays = edit ? Math.max(0, Math.floor((Date.now() / 1000 - edit[0]) / 86400)) : null;
	return { id, path, bytes: size, ageDays, ageFile: edit?.[1] ?? null, lastCommit: g.lastCommit, state: stateOf(size, ageDays, t), dirty: g.dirty, push: g.push };
}
