/**
 * The process snapshot contract, as `atlas ps` and `atlas kill` use it. Source of truth:
 * atlas-api/src/lib/processes/types.ts (GET /api/processes, POST /api/processes/stop) — change both
 * together. Only the fields the CLI reads are mirrored; `--json` passes the API's rows through whole.
 * Units: bytes, seconds, % of one core, ISO 8601.
 */

export const PROCESS_KINDS = [
	'claude',
	'codex',
	'mcp',
	'language-server',
	'bun',
	'node',
	'deno',
	'uv',
	'python',
	'cargo',
	'rustc',
	'go',
	'dolt',
	'beads',
	'docker',
	'caddy',
	'ollama',
	'shell',
	'app',
	'system',
	'other'
] as const;
export type ProcessKind = (typeof PROCESS_KINDS)[number];

export interface ProcessProject {
	name: string;
	path: string;
	slug?: string;
}

export interface ProcessInfo {
	pid: number;
	/** pid + startedAt is a process's identity; a reused pid has another start. */
	startedAt: string;
	kind: ProcessKind;
	name: string;
	/** argv with secrets redacted server-side; '' when ps could not read it. */
	command: string;
}

/** One app row: a process group folded into the process doing the work. */
export interface AppRow {
	id: string;
	pgid: number;
	/** pid of the main process the row is named after. */
	primary: number;
	kind: ProcessKind;
	tool?: string;
	name: string;
	project?: ProcessProject;
	/** A development process — the default view. */
	dev: boolean;
	pids: number[];
	cpu: number;
	rss: number;
	uptime: number;
	ports: number[];
	launchd?: string;
	flags: ('orphan' | 'duplicate' | 'idle' | 'heavy')[];
}

export interface ProcessSnapshot {
	generatedAt: string;
	rows: AppRow[];
	/** Exactly the members of `rows`. */
	processes: ProcessInfo[];
}

export interface StopTarget {
	pid: number;
	startedAt: string;
}

export interface StopRequest {
	targets: StopTarget[];
	tree?: boolean;
	force?: boolean;
	dryRun?: boolean;
}

export type StopRefusal = 'pid-reused' | 'protected-pid' | 'other-user' | 'atlas-api' | 'launchd-job' | 'zombie';

export interface StopResult {
	pid: number;
	startedAt: string;
	status: 'would-stop' | 'stopped' | 'killed' | 'still-running' | 'gone' | 'refused';
	refusal?: StopRefusal;
	/** The launchd label behind a `launchd-job` refusal — restart it through `atlas daemons` instead. */
	label?: string;
	tree?: number[];
}

export interface EndingProcess {
	pid: number;
	ppid: number;
	pgid: number;
	startedAt: string;
	kind: ProcessKind;
	name: string;
	command: string;
}

/** Always 200 for a well-formed body, even when every target is refused. */
export interface StopResponse {
	dryRun: boolean;
	generatedAt: string;
	/** One per target, in request order. */
	results: StopResult[];
	/** Every process that ends (or would): targets plus tree members that passed the checks. */
	wouldEnd: EndingProcess[];
	/** Tree members refused on their own. */
	skipped: { pid: number; name: string; refusal: StopRefusal; label?: string }[];
}
