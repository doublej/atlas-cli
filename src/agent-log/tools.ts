/**
 * Tool → scope derivation for the PreToolUse guard. Edit/patch tools yield
 * deterministic path scopes (strict-able); Bash parses a small allowlist of
 * known mutations (git state, installs, migrations, deploys, service/port ops)
 * and anything else is opaque — never pretend arbitrary shell is parseable.
 */
import { basename } from 'node:path';
import { normalizeScope, ScopeError } from './scopes';

export type DerivedScopes = {
	scopes: string[];
	opaque: boolean;
	note: string;
};

const DETERMINISTIC_TOOLS = new Set([
	'Edit',
	'Write',
	'MultiEdit',
	'NotebookEdit',
	'apply_patch',
	'Bash',
	'Git'
]);

const READ_TOOLS = new Set([
	'Read',
	'Glob',
	'Grep',
	'WebFetch',
	'WebSearch',
	'Task',
	'TodoWrite',
	'ExitPlanMode',
	'AskUserQuestion',
	'KillShell',
	'LS'
]);

function pathScopes(values: (string | undefined)[], root: string, note: string[]): string[] {
	const scopes: string[] = [];
	for (const value of values) {
		if (!value) continue;
		try {
			scopes.push(normalizeScope(`path:${value}`, root).scope);
		} catch (error) {
			if (error instanceof ScopeError) note.push(String(error.message));
			else throw error;
		}
	}
	return scopes;
}

/** Extract target paths from an apply_patch diff (+++ / --- header lines). */
function patchPaths(patch: string, root: string, note: string[]): string[] {
	const paths = [
		...new Set(
			patch
				.split('\n')
				.filter((line) => line.startsWith('+++ ') || line.startsWith('--- '))
				.map((line) => line.slice(4).trim().replace(/\t.*$/, ''))
				.filter((path) => !path.includes(' *') && path !== '/dev/null')
				.map((path) => (path.startsWith('a/') || path.startsWith('b/') ? path.slice(2) : path))
		)
	];
	return pathScopes(paths, root, note);
}

/** Worktree token for git scopes: '' in the main worktree, else the linked worktree's name. */
export function worktreeToken(cwd: string): string {
	const common = Bun.spawnSync(
		['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'],
		{ cwd, stderr: 'ignore' }
	);
	if (common.exitCode !== 0) return 'main';
	const dir = Bun.spawnSync(['git', 'rev-parse', '--git-dir'], { cwd, stderr: 'ignore' });
	if (dir.exitCode !== 0) return 'main';
	const relative = dir.stdout.toString().trim().replace(common.stdout.toString().trim(), '');
	return relative === '' || relative === '.git' ? 'main' : basename(relative.trim());
}

function gitScopes(command: string, wt: string, note: string[]): { scopes: string[]; opaque: boolean } {
	const indexOps = /\bgit\s+(add|commit|rm|mv|restore|reset|stash)\b/.exec(command);
	if (indexOps) return { scopes: [`git:index:${wt}`], opaque: false };
	const branch = /\bgit\s+checkout\s+-b\s+([^\s]+)/.exec(command) ?? /\bgit\s+merge\s+([^\s]+)/.exec(command);
	if (branch) return { scopes: [`git:ref:refs/heads/${branch[1]}`], opaque: false };
	if (/\bgit\s+(merge|rebase|tag|branch\s+-D|checkout\s+-B)/.test(command))
		return { scopes: [`git:ref:${wt}`], opaque: false };
	if (/\bgit\s+(push|pull|fetch|remote|submodule\s+update)/.test(command))
		return { scopes: [`git:remote:${wt}`], opaque: false };
	note.push('git command outside the allowlist — opaque');
	return { scopes: [], opaque: true };
}

/**
 * The Bash allowlist: only these mutation classes are scope-derivable.
 * Everything else is opaque (context, never a block).
 */
export function deriveBashScopes(command: string, root: string): DerivedScopes {
	const wt = worktreeToken(root);
	const note: string[] = [];
	const gitRead =
		/^\s*git\s+(status|log|diff|show|branch\b|rev-parse|ls-files|config|remote\s+-v|--version|help)/.test(
			command
		);
	const noteText = (): string => note.join('; ');
	if (/\bgit\b/.test(command) && !gitRead) {
		const derived = gitScopes(command, wt, note);
		return { scopes: derived.scopes, opaque: derived.opaque, note: noteText() };
	}
	if (gitRead) return { scopes: [], opaque: false, note: 'read-only git' };
	if (/\b(npm|bun|pnpm|yarn|pip|pip3|uv|poetry|brew|cargo|gem)\s+(install|add|ci|i|sync|update|upgrade|remove|uninstall)\b/.test(command))
		return { scopes: ['artifact:install'], opaque: false, note: noteText() };
	if (/\b(prisma|drizzle-kit|alembic|flyway|knex)\b.*\b(migrate|db\s+push|db\s+seed|upgrade|downgrade|revision)\b/.test(command))
		return { scopes: ['service:database'], opaque: false, note: noteText() };
	if (/\b(wrangler|vercel|flyctl|fly|netlify|railway|gh|rsync|scp|docker)\s+(deploy|publish|rollback|up|machines|workflow\s+run|release\s+create|push)\b/.test(command))
		return { scopes: ['service:deploy'], opaque: false, note: noteText() };
	const port = /(?:lsof\s+-ti\s*:(\d+)|nc\s+-l\s+(\d+)|socat\b[^|]*TCP[^|]*:(\d+))/.exec(command);
	if (port) {
		const value = port[1] ?? port[2] ?? port[3];
		return { scopes: [`port:${value}`], opaque: false, note: noteText() };
	}
	if (/\b(launchctl|kill|pkill|killall)\b/.test(command))
		return { scopes: ['service:process'], opaque: false, note: noteText() };
	note.push('shell command outside the allowlist — opaque');
	return { scopes: [], opaque: true, note: noteText() };
}

/** Derive the coordination scopes a tool call will mutate. */
export function deriveToolScopes(
	toolName: string,
	toolInput: Record<string, unknown>,
	root: string
): DerivedScopes {
	if (!DETERMINISTIC_TOOLS.has(toolName) && !READ_TOOLS.has(toolName)) {
		return { scopes: [], opaque: true, note: `${toolName} outside the allowlist` };
	}
	const note: string[] = [];
	if (toolName === 'Edit' || toolName === 'Write' || toolName === 'MultiEdit')
		return {
			scopes: pathScopes([String(toolInput.file_path ?? '')], root, note),
			opaque: false,
			note: note.join('; ')
		};
	if (toolName === 'NotebookEdit')
		return {
			scopes: pathScopes([String(toolInput.notebook_path ?? '')], root, note),
			opaque: false,
			note: note.join('; ')
		};
	if (toolName === 'apply_patch') {
		const patch = typeof toolInput.patch === 'string' ? toolInput.patch : JSON.stringify(toolInput.patch ?? '');
		return { scopes: patchPaths(patch, root, note), opaque: false, note: note.join('; ') };
	}
	if (toolName === 'Bash') {
		const command = String(toolInput.command ?? '');
		if (!command.trim()) return { scopes: [], opaque: true, note: 'empty command' };
		return deriveBashScopes(command, root);
	}
	if (toolName === 'Git') {
		const command = String(toolInput.command ?? '');
		const derived = gitScopes(command, worktreeToken(root), note);
		return { scopes: derived.scopes, opaque: derived.opaque, note: note.join('; ') };
	}
	return { scopes: [], opaque: false, note: `read-only tool: ${toolName}` };
}