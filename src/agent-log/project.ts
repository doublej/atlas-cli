/**
 * Agent Log v2 project boundary resolution. The nearest ancestor `.atlas` is the
 * explicit coordination boundary — even when it contains nested Git repositories.
 * Without a `.atlas`, fall back to the nearest Git common dir (worktree-shared).
 * Non-Git workspaces get an Atlas state directory keyed by the stable id.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export type CoordinationMode = 'off' | 'observe' | 'warn' | 'enforce';
export type BoundaryKind = 'atlas' | 'git';

export type Workspace = {
	id: string;
	root: string;
	mode: CoordinationMode;
	members: string[];
	aliases: Record<string, string[]>;
	boundary: BoundaryKind;
	stateDir: string;
};

export type AtlasMeta = {
	'agent-log'?: {
		id?: string;
		mode?: CoordinationMode;
		members?: string[];
		aliases?: Record<string, string[]>;
	};
};

/** Stable 16-hex id derived from a boundary anchor (the .atlas dir or git common dir). */
export const hashOf = (input: string): string =>
	createHash('sha256').update(input).digest('hex').slice(0, 16);

function git(args: string[], cwd: string): string {
	const result = Bun.spawnSync(['git', ...args], { cwd, stderr: 'ignore' });
	return result.exitCode === 0 ? result.stdout.toString().trim() : '';
}

/** Nearest ancestor `.atlas` file (or directory) — the explicit coordination boundary. */
function nearestAtlas(cwd: string): string | null {
	let dir = realpathSync(cwd);
	for (;;) {
		const candidate = join(dir, '.atlas');
		if (existsSync(candidate)) return candidate;
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

export function readAtlasMeta(atlasPath: string): AtlasMeta {
	try {
		return JSON.parse(readFileSync(atlasPath, 'utf8')) as AtlasMeta;
	} catch (error) {
		throw new Error(`invalid .atlas metadata at ${atlasPath}: ${(error as Error).message}`);
	}
}

function atlasStateDir(id: string): string {
	const base = process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share');
	return join(base, 'atlas', 'state', id);
}

function atlasWorkspace(atlasPath: string): Workspace {
	const root = dirname(realpathSync(atlasPath));
	const config = readAtlasMeta(atlasPath)['agent-log'];
	// An explicit agent-log block opts into coordination (default warn);
	// a bare .atlas (no block) is observed only.
	const mode = config ? (config.mode ?? 'warn') : 'observe';
	const id = config?.id ?? hashOf(root);
	const members = config?.members ?? [];
	const aliases = config?.aliases ?? {};
	const commonDir = git(['rev-parse', '--path-format=absolute', '--git-common-dir'], root);
	const stateDir = commonDir ? realpathSync(commonDir) : atlasStateDir(id);
	return { id, root, mode, members, aliases, boundary: 'atlas', stateDir };
}

/** The coordination workspace for `cwd`, or null when neither `.atlas` nor a Git repo exists. */
export function resolveWorkspace(cwd: string): Workspace | null {
	const atlas = nearestAtlas(cwd);
	if (atlas) return atlasWorkspace(atlas);
	const root = git(['rev-parse', '--show-toplevel'], cwd);
	const commonDir = git(['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd);
	if (!root || !commonDir) return null;
	return {
		id: hashOf(realpathSync(commonDir)),
		root: realpathSync(root),
		mode: 'observe',
		members: [],
		aliases: {},
		boundary: 'git',
		stateDir: realpathSync(commonDir)
	};
}