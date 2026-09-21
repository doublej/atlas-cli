/**
 * The operation log: append-only JSONL, kept forever. Every change to files writes a
 * `start` record (fsync'd) before it begins and an `end` record after. A `start` with no
 * `end` is an interrupted operation — `pending()` finds those, and `recover` resolves them.
 * Long operations add `step` records so recovery knows which phase they died in.
 */
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, writeSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { ensureStateDir, statePath } from './settings';

export type Outcome = 'done' | 'skipped' | 'refused' | 'failed';
export type Actor = 'user' | 'schedule' | 'agent';

export interface StartRecord {
	t: 'start';
	id: string;
	run: string;
	at: string;
	actor: Actor;
	/** archive | restore | delete-archive | evict | clean | trim | rust-sweep | recover | manual-trash | manual-move | manual-run | manual-skip | manual-note */
	op: string;
	/** What is acted on: `<category>/<project>`, a version id, a path, a trim step. */
	item: string;
	/** Where it goes (archive file, restore target, Trash). */
	target?: string;
	bytes?: number;
	details?: Record<string, unknown>;
}
export interface StepRecord {
	t: 'step';
	id: string;
	at: string;
	phase: string;
	details?: Record<string, unknown>;
}
export interface EndRecord {
	t: 'end';
	id: string;
	at: string;
	outcome: Outcome;
	message?: string;
	/** Measured change in free space, bytes (positive = freed). */
	freed?: number;
	details?: Record<string, unknown>;
}
export type LogRecord = StartRecord | StepRecord | EndRecord;

const LOG = () => statePath('operations.jsonl');
const newId = () => `${stamp()}-${randomBytes(3).toString('hex')}`;

/** `YYYYMMDD-HHMMSS` in local time — also the archive version identifier format. */
export function stamp(d = new Date()): string {
	const p = (n: number) => String(n).padStart(2, '0');
	return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** One id per process invocation, so one run's records read together. */
export const RUN_ID = newId();

let actorOverride: Actor | undefined;
export const setActor = (a: Actor): void => {
	actorOverride = a;
};
export function currentActor(): Actor {
	if (actorOverride) return actorOverride;
	return process.env.CLAUDECODE || process.env.CODEX_THREAD_ID || process.env.AGENT_ID ? 'agent' : 'user';
}

/** Durable append: throws if the record can't be written, so the change never starts. */
function append(rec: LogRecord): void {
	ensureStateDir();
	const fd = openSync(LOG(), 'a');
	try {
		writeSync(fd, `${JSON.stringify(rec)}\n`);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

export function start(rec: Omit<StartRecord, 't' | 'id' | 'run' | 'at' | 'actor'>): string {
	const id = newId();
	append({ t: 'start', id, run: RUN_ID, at: new Date().toISOString(), actor: currentActor(), ...rec });
	return id;
}
export function step(id: string, phase: string, details?: Record<string, unknown>): void {
	append({ t: 'step', id, at: new Date().toISOString(), phase, details });
}
export function end(id: string, outcome: Outcome, rest: Omit<EndRecord, 't' | 'id' | 'at' | 'outcome'> = {}): void {
	append({ t: 'end', id, at: new Date().toISOString(), outcome, ...rest });
}

/** Records that aren't file changes (a refusal, a skip before anything started). */
export function note(rec: Omit<StartRecord, 't' | 'id' | 'run' | 'at' | 'actor'>, outcome: Outcome, message: string): void {
	const id = start(rec);
	end(id, outcome, { message });
}

export function readLog(): LogRecord[] {
	if (!existsSync(LOG())) return [];
	return readFileSync(LOG(), 'utf8')
		.split('\n')
		.filter(Boolean)
		.flatMap((line) => {
			try {
				return [JSON.parse(line) as LogRecord];
			} catch {
				return []; // a torn last line from a power loss: skip it, the start before it stays pending
			}
		});
}

export interface Operation {
	start: StartRecord;
	steps: StepRecord[];
	end?: EndRecord;
}

/** Start records joined with their steps and end, oldest first. */
export function operations(records = readLog()): Operation[] {
	const byId = new Map<string, Operation>();
	for (const r of records) {
		if (r.t === 'start') byId.set(r.id, { start: r, steps: [] });
		else if (r.t === 'step') byId.get(r.id)?.steps.push(r);
		else {
			const op = byId.get(r.id);
			if (op) op.end = r;
		}
	}
	return [...byId.values()];
}

/** Interrupted operations: a start with no end. `recover` is the only thing that may touch their items. */
export const pending = (): Operation[] => operations().filter((o) => !o.end);

/** The item is held by an interrupted operation (other than `exceptId`). */
export const isHeld = (item: string, exceptId?: string): Operation | undefined =>
	pending().find((o) => o.start.item === item && o.start.id !== exceptId);

