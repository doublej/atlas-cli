/** `agent-log init` — idempotent journal bootstrap: shim, CLAUDE.md policy, db warm-up. */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { END_MARKER, MARKER, POLICY_BLOCK, SHIM_CONTENT } from './policy';
import { warmDatabase } from './store';

function isGitRepo(cwd: string): boolean {
	const result = Bun.spawnSync(['git', 'rev-parse', '--git-dir'], {
		cwd,
		stdout: 'ignore',
		stderr: 'ignore'
	});
	return result.exitCode === 0;
}

function ensureShim(cwd: string): void {
	const path = join(cwd, 'agent-log');
	if (existsSync(path)) {
		if (readFileSync(path, 'utf8') !== SHIM_CONTENT)
			console.warn('agent-log: ./agent-log exists with different content — left untouched');
		return;
	}
	writeFileSync(path, SHIM_CONTENT, { mode: 0o755 });
	console.log('agent-log: wrote ./agent-log shim');
}

function ensurePolicyBlock(cwd: string): void {
	const path = join(cwd, 'CLAUDE.md');
	if (!existsSync(path)) {
		writeFileSync(path, POLICY_BLOCK);
		console.log('agent-log: created CLAUDE.md with the journal policy');
		return;
	}
	const current = readFileSync(path, 'utf8');
	const start = current.indexOf(MARKER);
	if (start === -1) {
		writeFileSync(path, current.replace(/\n*$/, '\n\n') + POLICY_BLOCK);
		console.log('agent-log: appended the journal policy to CLAUDE.md');
		return;
	}
	const end = policyBlockEnd(current, start);
	if (end === -1) {
		console.warn('agent-log: CLAUDE.md policy block has no recognisable end — left untouched');
		return;
	}
	const rest = current.slice(end).replace(/^\n*/, '');
	const next = current.slice(0, start) + POLICY_BLOCK.trimEnd() + (rest ? `\n\n${rest}` : '\n');
	if (next === current) return;
	writeFileSync(path, next);
	console.log('agent-log: rewrote the journal policy in CLAUDE.md');
}

/** Legacy blocks (before END_MARKER existed) all ended on this sentence. */
const LEGACY_END = 'so linked worktrees share it without dirtying the repo.';

/** Index just past the existing block, or -1 when its end can't be found. */
function policyBlockEnd(text: string, start: number): number {
	const closed = text.indexOf(END_MARKER, start);
	if (closed !== -1) return closed + END_MARKER.length;
	const legacy = text.indexOf(LEGACY_END, start);
	return legacy === -1 ? -1 : legacy + LEGACY_END.length;
}

function warmJournalDb(cwd: string): void {
	if (!isGitRepo(cwd)) return; // no repo yet — the store creates the db on first write
	warmDatabase(cwd);
}

/** Never throws for the expected non-git case; scaffolding must not fail on this. */
export function bootstrapJournal(cwd: string): void {
	ensureShim(cwd);
	ensurePolicyBlock(cwd);
	warmJournalDb(cwd);
}
