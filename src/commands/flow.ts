import { basename } from 'node:path';
import type { Command } from '../types';
import { apiGet } from '../api';
import { die, requireUp, resolveRoot } from '../util';

/** Mirrors `GitFlow` in atlas-api/src/lib/scanner.ts. */
interface GitFlow {
	policy: 'gitflow' | 'trunk' | 'external' | 'local';
	trunk: string;
	integration?: string;
	owner?: string;
	drift?: string;
}

interface FlowProject {
	name: string;
	path: string;
	relativePath: string;
	git?: string;
	gitBranch?: string;
	archived?: boolean;
	flow?: GitFlow;
}

const USAGE = `Usage: atlas flow [status]        branch flow of the current project
       atlas flow audit          which repos can safely move to feature → develop → main
       atlas flow init [path]    opt this repo in (creates develop, renames master → main)

Flags (init):
  --dry-run   print the git commands without running them
  --force     skip the safety checks (dirty tree, foreign remote, wrong branch)
`;

/** Run a git command in `cwd`; returns trimmed stdout, or null when it fails. */
async function git(cwd: string, ...args: string[]): Promise<string | null> {
	const p = Bun.spawn(['git', '-C', cwd, ...args], { stdout: 'pipe', stderr: 'pipe' });
	const out = await new Response(p.stdout).text();
	return (await p.exited) === 0 ? out.trim() : null;
}

async function gitOrDie(cwd: string, ...args: string[]): Promise<void> {
	const p = Bun.spawn(['git', '-C', cwd, ...args], { stdout: 'inherit', stderr: 'inherit' });
	if ((await p.exited) !== 0) die(`Failed: git ${args.join(' ')}`);
}

/** Merge a `flow` block into the project's `.atlas`, creating the file if needed. */
async function writeAtlasFlow(root: string, flow: Record<string, string>): Promise<void> {
	const file = Bun.file(`${root}/.atlas`);
	const meta = (await file.exists()) ? await file.json() : {};
	meta.flow = flow;
	await Bun.write(`${root}/.atlas`, JSON.stringify(meta, null, 2) + '\n');
}

/**
 * New projects are born on the flow: main + develop + the scaffold commit.
 * No-op when the folder is already a repo. Failures are non-fatal — the scaffold stands.
 */
export async function bootstrapFlow(root: string): Promise<void> {
	if (await Bun.file(`${root}/.git/HEAD`).exists()) return;
	await writeAtlasFlow(root, { policy: 'gitflow', trunk: 'main', integration: 'develop' });
	if (!(await git(root, 'init', '-b', 'main'))) return;
	await git(root, 'add', '-A');
	if (!(await git(root, 'commit', '-m', 'chore: scaffold project'))) return;
	await git(root, 'branch', 'develop');
	console.log('  git: main + develop (feature/* → develop → main → tag)');
}

/** `atlas flow` — what flow the repo in `root` is on right now. */
async function status(root: string): Promise<void> {
	await requireUp();
	const { projects } = await apiGet<{ projects: FlowProject[] }>('/api/projects');
	const p = projects.find((x) => x.path === root);
	if (!p?.flow) die(`No scanned project at ${root}. Run: atlas scan`);

	const f = p.flow;
	console.log(`${p.name}  (${f.policy})`);
	console.log(`  trunk:       ${f.trunk}`);
	console.log(`  integration: ${f.integration ?? '—'}`);
	console.log(`  remote:      ${f.owner ? `${f.owner} (main repository)` : 'none'}`);
	console.log(`  branch:      ${p.gitBranch ?? '—'}${p.git === 'dirty' ? ' (dirty)' : ''}`);
	if (f.drift) console.log(`  drift:       ${f.drift}`);
	if (f.policy === 'trunk') console.log(`\nNot on the flow yet. Opt in: atlas flow init`);
}

/** `atlas flow audit` — split own repos into "safe to migrate now" and "needs a look first". */
async function audit(): Promise<void> {
	await requireUp();
	const { projects } = await apiGet<{ projects: FlowProject[] }>('/api/projects');

	const ready: FlowProject[] = [];
	const blocked: [FlowProject, string][] = [];
	const done: FlowProject[] = [];
	let skipped = 0;

	for (const p of projects) {
		const f = p.flow;
		if (!f || f.policy === 'external' || f.policy === 'local' || p.archived) {
			skipped++;
			continue;
		}
		if (f.policy === 'gitflow') {
			done.push(p);
			continue;
		}
		// policy === 'trunk': ours, has a remote, no develop yet.
		const reason =
			p.git === 'dirty'
				? 'uncommitted changes'
				: p.git !== 'clean'
					? `git ${p.git ?? 'unknown'}`
					: p.gitBranch !== f.trunk
						? `on ${p.gitBranch}, not ${f.trunk}`
						: null;
		if (reason) blocked.push([p, reason]);
		else ready.push(p);
	}

	console.log(`Safe to migrate now (${ready.length}):`);
	for (const p of ready) {
		const rename = p.flow?.trunk === 'master' ? '  [master → main]' : '';
		console.log(`  ${p.relativePath}${rename}`);
	}

	if (blocked.length) {
		console.log(`\nNeeds a look first (${blocked.length}):`);
		for (const [p, reason] of blocked) console.log(`  ${p.relativePath}  — ${reason}`);
	}

	if (done.length) {
		console.log(`\nAlready on the flow (${done.length}):`);
		for (const p of done) console.log(`  ${p.relativePath}${p.flow?.drift ? `  — ${p.flow.drift}` : ''}`);
	}

	console.log(`\nSkipped ${skipped} (third-party clones, local-only repos, archived).`);
	console.log(`Migrate one: atlas flow init <path>`);
}

/** `atlas flow init` — create develop, rename master → main, record it in `.atlas`. */
async function init(root: string, dryRun: boolean, force: boolean): Promise<void> {
	const branch = await git(root, 'rev-parse', '--abbrev-ref', 'HEAD');
	if (!branch) die(`${root} is not a git repository with commits.`);

	const heads = (await git(root, 'for-each-ref', '--format=%(refname:short)', 'refs/heads')) ?? '';
	const branches = heads.split('\n').filter(Boolean);
	if (branches.includes('develop')) die(`${basename(root)} already has a develop branch.`);

	const remote = await git(root, 'config', '--get', 'remote.origin.url');
	const owner = remote ? /[:/]([^/:]+)\/[^/]+?(?:\.git)?\/?$/.exec(remote)?.[1] : undefined;
	const expected = process.env.ATLAS_GIT_OWNER ?? 'doublej';

	let trunk = branches.includes('main') ? 'main' : branches.includes('master') ? 'master' : branch;
	const rename = trunk === 'master';

	if (!force) {
		if (await git(root, 'status', '--porcelain')) die('Working tree is dirty. Commit or stash first.');
		if (owner && owner !== expected)
			die(`origin belongs to ${owner}, not ${expected} — that's a clone, not our main repository. Use --force to override.`);
		if (branch !== trunk) die(`On ${branch}, not ${trunk}. Switch to ${trunk} first.`);
	}

	const steps: string[][] = [];
	if (rename) {
		steps.push(['branch', '-m', 'master', 'main']);
		if (remote) steps.push(['push', '-u', 'origin', 'main']);
	}
	steps.push(['branch', 'develop', rename ? 'main' : trunk]);
	if (remote) steps.push(['push', '-u', 'origin', 'develop']);

	if (rename) trunk = 'main';

	if (dryRun) {
		for (const s of steps) console.log(`git -C ${root} ${s.join(' ')}`);
		console.log(`.atlas → flow: { policy: gitflow, trunk: ${trunk}, integration: develop }`);
		return;
	}

	for (const s of steps) await gitOrDie(root, ...s);
	await writeAtlasFlow(root, { policy: 'gitflow', trunk, integration: 'develop' });

	console.log(`${basename(root)}: feature/* → develop → ${trunk} → tag`);
	if (rename && remote) {
		console.log(`\nRemote still defaults to master. Finish it with:`);
		console.log(`  gh repo edit ${owner}/${basename(root)} --default-branch main`);
		console.log(`  git -C ${root} push origin --delete master`);
	}
	console.log(`\nCommit the .atlas change when you're ready.`);
}

/** `atlas flow` — inspect and roll out the feature → develop → trunk → tag flow. */
export const flow: Command = {
	name: 'flow',
	summary: 'branch flow: status, migration audit, opt a repo in',
	async run(args) {
		const [sub, ...rest] = args;
		const dryRun = rest.includes('--dry-run') || args.includes('--dry-run');
		const force = rest.includes('--force') || args.includes('--force');
		const pathArg = rest.find((a) => !a.startsWith('--'));

		if (sub === 'audit') return audit();
		if (sub === 'init') return init(resolveRoot(pathArg), dryRun, force);
		if (!sub || sub === 'status') return status(resolveRoot(pathArg));
		die(USAGE);
	}
};
