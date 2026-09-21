/**
 * The approval policy (spec table), in one place. Interactive runs confirm; unattended
 * (`--unattended`) and scheduled (`--scheduled`, set by the launchd jobs) runs never ask —
 * an item without approval is refused with the approval it needs, and the batch continues.
 */
import type { Flags } from './flags';
import { setActor } from './oplog';
import type { Settings } from './settings';

export type Mode = 'interactive' | 'unattended' | 'scheduled';
export type Operation =
	| 'archive'
	| 'archive-dirty'
	| 'restore'
	| 'delete-archive'
	| 'prune-archives'
	| 'clean-rebuildable'
	| 'clean-reinstallable'
	| 'clean-review'
	| 'clean-unclassified'
	| 'trim'
	| 'rust-sweep';

/** `confirm` = ask in interactive mode; `allow` = go ahead; `{ refuse }` = the approval it needs. */
export type Verdict = 'confirm' | 'allow' | { refuse: string };

export function modeOf(flags: Flags): Mode {
	if (flags.has('scheduled')) {
		setActor('schedule');
		return 'scheduled';
	}
	return flags.has('unattended') ? 'unattended' : 'interactive';
}

export function policy(op: Operation, mode: Mode, s: Settings, flags: Flags): Verdict {
	const never = { refuse: 'an interactive run (never allowed on a schedule)' };
	if (op === 'clean-unclassified') return { refuse: 'nothing — unclassified folders are never deleted' };
	if (mode === 'interactive') return op === 'rust-sweep' && !s.rustSweep && !flags.has('rust-sweep') ? { refuse: '--rust-sweep or `atlas disk config set rustSweep true`' } : 'confirm';
	const scheduled = mode === 'scheduled';
	switch (op) {
		case 'archive':
		case 'restore':
			return scheduled ? never : 'allow';
		case 'archive-dirty':
			return scheduled ? never : flags.has('include-dirty') ? 'allow' : { refuse: '--include-dirty (uncommitted or unpushed work)' };
		case 'delete-archive':
			return { refuse: 'an interactive confirmation (only the keep-newest-N rule deletes unattended)' };
		case 'prune-archives':
			return s.keepNewest ? 'allow' : { refuse: '`atlas disk config set keepNewest N`' };
		case 'clean-rebuildable':
			return !scheduled && s.autoCleanRebuildable ? 'allow' : scheduled ? never : { refuse: 'the standing rule `atlas disk config set autoCleanRebuildable true`' };
		case 'clean-reinstallable':
		case 'clean-review':
			return scheduled ? never : { refuse: 'an interactive confirmation' };
		case 'trim':
			return 'allow';
		case 'rust-sweep':
			return s.rustSweep || (!scheduled && flags.has('rust-sweep')) ? 'allow' : { refuse: '`atlas disk config set rustSweep true`' };
	}
}

/** Ask y/N on a terminal. With no terminal there is nobody to ask: that is a "no". */
export async function confirm(message: string): Promise<boolean> {
	if (!process.stdin.isTTY) return false;
	// Lazy: importing @inquirer/prompts at load time cuts piped stdout off at 64 KB.
	const { confirm: ask } = await import('@inquirer/prompts');
	return ask({ message, default: false });
}

/** Resolve a verdict to go/no-go. `plan` is shown before an interactive question. */
export async function approve(v: Verdict, question: string): Promise<true | { refuse: string }> {
	if (v === 'allow') return true;
	if (v !== 'confirm') return v;
	if (!process.stdin.isTTY) return { refuse: 'a confirmation — no terminal; rerun with --unattended where the policy allows it' };
	return (await confirm(question)) ? true : { refuse: 'your confirmation (declined)' };
}

/**
 * Cancellation: the first SIGINT/SIGTERM sets a flag that batch loops check at safe points;
 * the second exits hard. The TUI cancels a job by sending SIGINT to it.
 */
let cancelled = false;
export const isCancelled = (): boolean => cancelled;
export function trapCancel(): void {
	const onSignal = () => {
		if (cancelled) process.exit(130);
		cancelled = true;
		console.error('\ncancelling at the next safe point… (again to force)');
	};
	process.on('SIGINT', onSignal);
	process.on('SIGTERM', onSignal);
}
