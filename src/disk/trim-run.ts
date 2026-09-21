/**
 * Runs trim steps one by one: log-first, measured, time-limited. A step runs in its own
 * process group, so a timeout stops the tool *and* whatever it spawned — and the next step
 * starts only once that whole group is gone.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { isCancelled } from './approval';
import { duBytes, freeBytes, human } from './fsutil';
import * as oplog from './oplog';
import type { ItemReport } from './report';

export interface Step {
	name: string;
	/** 'trim' or 'rust-sweep' — the oplog op. */
	op: 'trim' | 'rust-sweep';
	/** Binaries that must be on PATH; the step is skipped when one is missing. */
	needs: string[];
	cmd: string[];
	/** The cache this step trims; measured before/after. */
	cache?: string;
	/** Set → never run, reported as skipped with this reason. */
	skip?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function groupAlive(pgid: number): boolean {
	try {
		process.kill(-pgid, 0);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === 'EPERM';
	}
}

function killGroup(pgid: number, signal: NodeJS.Signals): void {
	try {
		process.kill(-pgid, signal);
	} catch {
		// already gone
	}
}

/** SIGTERM the group, SIGKILL after `graceMs`, and return only once no member is left. */
async function stopGroup(pgid: number, graceMs: number): Promise<void> {
	killGroup(pgid, 'SIGTERM');
	const deadline = Date.now() + graceMs;
	while (groupAlive(pgid) && Date.now() < deadline) await sleep(100);
	killGroup(pgid, 'SIGKILL');
	while (groupAlive(pgid)) await sleep(100);
}

export interface ProcessResult {
	code: number | null;
	timedOut: boolean;
	error?: string;
}

/** Run `cmd` detached (own pgid), tool output to our stderr so `--json` stdout stays clean. */
export async function runProcess(cmd: string[], timeoutSec: number, graceMs = 5000): Promise<ProcessResult> {
	const child = spawn(cmd[0], cmd.slice(1), { detached: true, stdio: ['ignore', 2, 2] });
	const exited = new Promise<{ code: number | null; error?: string }>((resolve) => {
		child.on('exit', (code) => resolve({ code }));
		child.on('error', (e) => resolve({ code: null, error: e.message }));
	});
	let stopping: Promise<void> | undefined;
	const timer = setTimeout(() => {
		if (child.pid) stopping = stopGroup(child.pid, graceMs);
	}, timeoutSec * 1000);
	const { code, error } = await exited;
	clearTimeout(timer);
	await stopping;
	return { code, timedOut: stopping !== undefined, error };
}

const measure = (cache?: string) => (cache && existsSync(cache) ? duBytes(cache) : undefined);

/** One step, oplog start before and end after. Never throws for a tool failure. */
export async function runStep(step: Step, timeoutSec: number): Promise<ItemReport> {
	const missing = step.needs.filter((t) => !Bun.which(t));
	if (step.skip || missing.length) {
		const reason = step.skip ?? `not installed: ${missing.join(', ')}`;
		oplog.note({ op: step.op, item: step.name, target: step.cache }, 'skipped', reason);
		return { item: step.name, outcome: 'skipped', reason };
	}
	const cmd = [Bun.which(step.cmd[0]) ?? step.cmd[0], ...step.cmd.slice(1)];
	const id = oplog.start({ op: step.op, item: step.name, target: step.cache, details: { cmd } });
	const cacheBefore = measure(step.cache);
	const freeBefore = freeBytes(homedir());
	const started = Date.now();
	const r = await runProcess(cmd, timeoutSec);
	const cacheAfter = measure(step.cache);
	const freed = cacheBefore !== undefined && cacheAfter !== undefined ? cacheBefore - cacheAfter : freeBytes(homedir()) - freeBefore;
	const seconds = Math.round((Date.now() - started) / 1000);
	const changed = cacheBefore !== undefined ? `cache ${human(cacheBefore)} → ${human(cacheAfter ?? 0)}` : `free space ${freed >= 0 ? '+' : ''}${human(freed)}`;
	const outcome = r.code === 0 && !r.timedOut ? 'done' : 'failed';
	const reason = r.timedOut
		? `timed out after ${timeoutSec}s and was stopped; already changed: ${changed}`
		: outcome === 'failed'
			? `${r.error ?? `exit ${r.code}`}; ${changed}`
			: undefined;
	const details = { cacheBefore, cacheAfter, seconds, timedOut: r.timedOut, exitCode: r.code };
	oplog.end(id, outcome, { freed, message: reason, details });
	return { item: step.name, outcome, reason, freed, ...details };
}

/** Batch: every step runs whatever the previous one did; a cancel skips the rest. */
export async function runSteps(steps: Step[], timeoutSec: number): Promise<ItemReport[]> {
	const out: ItemReport[] = [];
	for (const step of steps) {
		if (isCancelled()) out.push({ item: step.name, outcome: 'skipped', reason: 'cancelled before it started' });
		else out.push(await runStep(step, timeoutSec));
	}
	return out;
}
