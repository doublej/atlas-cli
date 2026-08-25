/** `agent-log init` — idempotent journal bootstrap: shim, CLAUDE.md policy, db warm-up. */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MARKER, POLICY_BLOCK, SHIM_CONTENT } from './policy';
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
	if (current.includes(MARKER)) return;
	writeFileSync(path, current.replace(/\n*$/, '\n\n') + POLICY_BLOCK);
	console.log('agent-log: appended the journal policy to CLAUDE.md');
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
