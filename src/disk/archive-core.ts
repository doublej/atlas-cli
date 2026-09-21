/**
 * Archive building blocks: file naming, the manifest sidecar, and the content fingerprint.
 * The fingerprint is bsdtar's mtree writer — it prints identical text for a source folder
 * and for an archive of it, so "verified" is a string compare.
 */
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { execOk } from './archive-exec';

/** Rebuildable folders left out by default (archive.sh's NOISE_DIRS). */
export const REBUILDABLE = ['node_modules', '.venv', 'venv', '__pycache__', 'target', '.next', '.svelte-kit', '.cache', 'dist', 'build', '.build', 'DerivedData'];
/** Always left out, even with --keep-rebuildable: Finder rewrites it while we read. */
export const ALWAYS_EXCLUDED = ['.DS_Store'];

/** `<name>.<YYYYMMDD[-HHMMSS]>.tar[.zst]` — legacy archive.sh archives are `.YYYYMMDD.tar`. */
export const ARCHIVE_RE = /^(.+)\.(\d{8}(?:-\d{6})?)\.tar(\.zst)?$/;

export interface Manifest {
	version: string;
	project: string;
	source: string;
	createdAt: string;
	compression: number;
	excludes: string[];
	/** What the excludes actually matched, relative to the project. */
	leftOut: string[];
	fileCount: number;
	totalBytes: number;
	mtree: string;
	verified: boolean;
	note?: string;
}

export const manifestPath = (file: string): string => `${file}.manifest.json`;

export function readManifest(file: string): Manifest | null {
	const p = manifestPath(file);
	return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as Manifest) : null;
}

export function archiveFile(archiveDir: string, project: string, version: string, compression: number): string {
	return join(archiveDir, `${project}.${version}.tar${compression > 0 ? '.zst' : ''}`);
}

const exclude = (excludes: string[]) => excludes.flatMap((e) => ['--exclude', e]);
const SUM = '!all,type,size,sha256,link';
const SNAPSHOT = '!all,type,size,time,link';

/** mtree of `<categoryDir>/<name>` (entries `./<name>/…`). `snapshot` = cheap size+time only. */
export function sourceMtree(projectDir: string, excludes: string[], snapshot = false): Promise<string> {
	const opts = snapshot ? SNAPSHOT : SUM;
	return execOk(['tar', '-cf', '-', '--format=mtree', `--options=${opts}`, ...exclude(excludes), '-C', dirname(projectDir), basename(projectDir)]);
}

export const archiveMtree = (file: string): Promise<string> => execOk(['tar', '-cf', '-', '--format=mtree', `--options=${SUM}`, `@${file}`]);

export async function writeArchive(projectDir: string, out: string, excludes: string[], level: number): Promise<void> {
	const zstd = level > 0 ? ['--zstd', '--options', `zstd:compression-level=${level},zstd:threads=0`] : [];
	await execOk(['tar', '-cf', out, ...zstd, ...exclude(excludes), '-C', dirname(projectDir), basename(projectDir)]);
}

/** Paths the excludes match (pruned at the first match), relative to the project. */
export async function leftOut(projectDir: string, excludes: string[]): Promise<string[]> {
	const names = excludes.flatMap((n, i) => (i ? ['-o', '-name', n] : ['-name', n]));
	const out = await execOk(['find', projectDir, '-mindepth', '1', '(', ...names, ')', '-prune', '-print']);
	return out.split('\n').filter(Boolean).map((p) => p.slice(projectDir.length + 1));
}

/** mtree text → entries (vis-decoded path, type, size). */
export function mtreeEntries(mtree: string): { path: string; type: string; size: number }[] {
	return mtree
		.split('\n')
		.filter((l) => l && !l.startsWith('#'))
		.map((l) => {
			const [raw, ...kv] = l.split(' ');
			const attrs = Object.fromEntries(kv.map((x) => x.split('=', 2)));
			const path = raw.replace(/^\.\//, '').replace(/\\(\d{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)));
			return { path, type: attrs.type ?? '?', size: Number(attrs.size ?? 0) };
		});
}

export function mtreeStats(mtree: string): { fileCount: number; totalBytes: number } {
	const files = mtreeEntries(mtree).filter((e) => e.type === 'file');
	return { fileCount: files.length, totalBytes: files.reduce((n, e) => n + e.size, 0) };
}
