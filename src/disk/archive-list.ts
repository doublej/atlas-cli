/** Every archive version under the archive folder, legacy archive.sh `.tar`s included. */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ARCHIVE_RE, readManifest } from './archive-core';
import { storageStates } from './icloud';
import type { ArchiveVersion } from './types';

const dirs = (p: string) => readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.'));

/** `20260513` → ISO date; `20260921-101500` → ISO local time. */
function versionDate(v: string): string {
	const [d, t = '000000'] = v.split('-');
	return new Date(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8), +t.slice(0, 2), +t.slice(2, 4), +t.slice(4, 6)).toISOString();
}

function versionOf(archiveDir: string, category: string, name: string): Omit<ArchiveVersion, 'storage'> | null {
	const m = ARCHIVE_RE.exec(name);
	if (!m) return null;
	const file = join(archiveDir, category, name);
	const project = `${category}/${m[1]}`;
	const st = statSync(file);
	const manifest = readManifest(file);
	const base = { id: `${project}@${m[2]}`, project, version: m[2], file, bytes: st.size, localBytes: st.blocks * 512 };
	if (!manifest) return { ...base, verified: false, verifyNote: 'no record of contents', createdAt: versionDate(m[2]) };
	return { ...base, verified: manifest.verified, ...(manifest.note ? { verifyNote: manifest.note } : {}), createdAt: manifest.createdAt };
}

/** Sorted by project, newest version first. */
export async function listVersions(archiveDir: string): Promise<ArchiveVersion[]> {
	if (!existsSync(archiveDir)) return [];
	const found = dirs(archiveDir).flatMap((c) =>
		readdirSync(join(archiveDir, c.name)).flatMap((f) => versionOf(archiveDir, c.name, f) ?? [])
	);
	found.sort((a, b) => a.project.localeCompare(b.project) || b.version.localeCompare(a.version));
	const storage = await storageStates(found.map((v) => v.file));
	return found.map((v, i) => ({ ...v, storage: storage[i] }));
}

/** A version id picks that version; a `<category>/<project>` picks its newest. */
export function resolveVersion(all: ArchiveVersion[], ref: string): ArchiveVersion | undefined {
	return ref.includes('@') ? all.find((v) => v.id === ref) : all.find((v) => v.project === ref);
}

/** Versions beyond the newest `keep` per project. `keep` ≥ 1, so a project's only version never qualifies. */
export function pruneCandidates(all: ArchiveVersion[], keep: number): ArchiveVersion[] {
	const k = Math.max(1, Math.floor(keep));
	const seen = new Map<string, number>();
	return all.filter((v) => {
		const n = (seen.get(v.project) ?? 0) + 1;
		seen.set(v.project, n);
		return n > k;
	});
}
