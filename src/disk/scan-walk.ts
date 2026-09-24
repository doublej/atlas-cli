/**
 * The walk (one `find`, pruned at every match, as bloat.sh did), the "is this really ours"
 * content checks, and the in-use heuristic.
 */
import { readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { PATTERNS, USERS, WALK_PRUNE } from './scan-rules';

/** Every folder whose name is a pattern, not descending into a match or a pruned root. */
export function findHits(root: string): string[] {
	const prune = ['(', '-path', `${root}/.*`, '-o', '-name', '.git', '-o', '-name', '*.app'];
	for (const rel of WALK_PRUNE) prune.push('-o', '-path', join(root, rel));
	prune.push(')', '-prune', '-o');
	const names = PATTERNS.flatMap((n, i) => (i ? ['-o', '-name', n] : ['-name', n]));
	const r = Bun.spawnSync(['find', root, ...prune, '-type', 'd', '(', ...names, ')', '-prune', '-print'], { stderr: 'ignore' });
	return r.stdout.toString().split('\n').filter(Boolean);
}

/**
 * Why a pattern hit is really review-level, or null. A parent is as risky as its contents:
 * a git repo inside, files git tracks (build output is never committed), or — for
 * `__pycache__` — files that aren't bytecode.
 * ponytail: .git is looked for 4 levels deep only; a project buried deeper passes unseen.
 */
export function foreignReason(path: string): string | null {
	// SwiftPM keeps its dependency clones (git repos) in .build/checkouts and .build/repositories: expected there
	const expected = basename(path) === '.build' ? ['(', '-path', `${path}/checkouts`, '-o', '-path', `${path}/repositories`, ')', '-prune', '-o'] : [];
	const git = Bun.spawnSync(['find', path, '-maxdepth', '4', ...expected, '-name', '.git', '-print', '-quit'], { stderr: 'ignore' }).stdout.toString().trim();
	if (git) return `contains another project (${git.slice(path.length + 1)})`;
	const tracked = Bun.spawnSync(['git', '-C', dirname(path), 'ls-files', '--', basename(path)], { stderr: 'ignore' }).stdout.toString();
	if (tracked.trim()) return 'holds files tracked in git (not build output)';
	if (basename(path) === '__pycache__') {
		const odd = readdirSync(path).find((n) => !/\.py[co]$/.test(n));
		if (odd) return `holds files that aren't bytecode (${odd})`;
	}
	return null;
}

/**
 * Something seems to be using the folder: a process whose working directory is inside it
 * (or, for a pattern hit, is the project it belongs to — a dev server runs from there), or a
 * known app for a singleton is running.
 * ponytail: working directories only (one `lsof -d cwd`); a process holding open files inside
 * with its cwd elsewhere is not seen. Per-folder `lsof +D` is exact but minutes slow.
 */
export function inUseChecker(root: string): (path: string, projectDir: string | null) => string | null {
	const cwds: { pid: string; cmd: string; cwd: string }[] = [];
	const lsof = Bun.spawnSync(['/usr/sbin/lsof', '-w', '-b', '-n', '-P', '-a', '-d', 'cwd', '-Fpcn'], { stderr: 'ignore', timeout: 20_000 });
	let pid = '';
	let cmd = '';
	for (const line of lsof.stdout.toString().split('\n')) {
		if (line[0] === 'p') pid = line.slice(1);
		else if (line[0] === 'c') cmd = line.slice(1);
		else if (line[0] === 'n') cwds.push({ pid, cmd, cwd: line.slice(1) });
	}
	const running = new Set(Bun.spawnSync(['ps', '-axco', 'comm=']).stdout.toString().split('\n').map((s) => s.trim()));
	return (path, projectDir) => {
		const inside = cwds.find((c) => c.cwd === path || c.cwd.startsWith(`${path}/`) || c.cwd === projectDir);
		if (inside) return `${inside.cmd} (pid ${inside.pid}) works in ${inside.cwd === projectDir ? 'its project' : 'it'}`;
		const users = USERS[path.slice(root.length + 1)] ?? [];
		const app = users.find((u) => running.has(u));
		return app ? `${app} is running` : null;
	};
}
