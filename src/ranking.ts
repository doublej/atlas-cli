// How `atlas search` and `atlas jump` decide what a query means. Pure — no API, no shell.

export type Project = {
	name: string;
	slug?: string;
	path: string;
	relativePath: string;
	host?: string;
	/** Absent for Fractal/Ubuntu projects — their paths do not exist on this machine. */
	isLocal?: boolean;
};

/**
 * Local before remote, then exact name, then name prefix, then a path hit.
 *
 * Locality is the *first* key, not a tie-break: `pj framelink` matches 25 projects across two
 * machines, none of them exactly, and the old alphabetical tie-break handed it to Fractal's
 * `_buildcheck` — an underscore sorts before every letter — which `jump` then refused because
 * the path does not exist here. A remote project can never outrank a local one again.
 */
export const rank = (p: Project, q: string): number => {
	const name = p.name.toLowerCase();
	const quality = name === q ? 0 : name.startsWith(q) ? 1 : 2;
	return (p.isLocal ? 0 : 10) + quality;
};

const matches = (p: Project, q: string): boolean =>
	p.name.toLowerCase().includes(q) || p.relativePath.toLowerCase().includes(q);

/** Depth, so a container's own app wins over a worktree buried three levels under it. */
const depth = (p: Project): number => p.relativePath.split(/[\\/]/).length;

export const rankProjects = (projects: Project[], q: string): Project[] =>
	projects
		.filter((p) => matches(p, q))
		.sort((a, b) => rank(a, q) - rank(b, q) || depth(a) - depth(b) || a.name.localeCompare(b.name));

/**
 * The folder named exactly like the query, when the scan knows one.
 *
 * `multi-stack/framelink` holds `app`, `auth`, `broker` and a pile of worktrees but is not
 * itself a project, so no amount of project ranking lands you in it — and it is what you meant
 * by `pj framelink`. Folders come from the primary scan only, so this can never point off-machine.
 * Ambiguity is broken by how many projects live under the folder: the one that is a workspace
 * wins over a same-named payload directory in `_data`.
 */
export function findFolder(folders: string[], projects: Project[], query: string): string | undefined {
	const named = folders.filter((f) => f.split('/').pop()?.toLowerCase() === query);
	if (named.length === 0) return undefined;
	const weight = (f: string): number =>
		projects.filter((p) => p.isLocal && p.relativePath.startsWith(`${f}/`)).length;
	return named.sort((a, b) => weight(b) - weight(a) || a.length - b.length)[0];
}
