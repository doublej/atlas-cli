import { parseArgs } from 'node:util';
import type { Command } from '../types';
import { apiGet, apiPost } from '../api';
import { die, requireUp } from '../util';
import { confirm } from '../disk/approval';
import { EXIT, exitFor, renderItems, type ItemReport } from '../disk/report';
import type { Outcome } from '../disk/oplog';
import type { ProcessSnapshot, StopRefusal, StopRequest, StopResponse, StopResult } from '../processes';
import { ancestry, type ListenerRef, type NamedTarget, pidTargets, portTargets, projectTargets, targetKind } from '../kill-targets';

const USAGE = `Usage: atlas kill <pid | :port | project> [--tree] [--force] [--all] [--dry-run] [--yes] [--json]

Stops processes through atlas-api, which re-checks every target (pid + start time) and refuses
pid ≤ 1, atlas-api itself, other users' processes, launchd jobs and zombies. This command never
targets itself or its ancestors (the shell and agent session running it).

  <pid>       one process            :<port>    whatever listens on that port
  <project>   that project's dev processes (name or slug, as \`atlas ps --project\`) — never its
              agent sessions, MCP servers, shells or language servers; --all adds non-dev rows
  --tree      also its descendants   --force    SIGKILL what still runs 5s after SIGTERM
  --dry-run   show what would stop and what is refused; signal nothing
  --yes       skip the confirmation (required without a terminal)
  --json      the API's StopResponse on stdout

Exit: 0 stopped · 1 error · 2 nothing matched · 3 partly failed · 4 refused or needs --yes`;

const OUTCOME: Record<StopResult['status'], Outcome> = {
	'would-stop': 'done',
	stopped: 'done',
	killed: 'done',
	gone: 'skipped',
	'still-running': 'failed',
	refused: 'refused'
};

const refusalText = (r: StopRefusal, label?: string): string =>
	r === 'launchd-job' ? `launchd job ${label} (restart it: atlas daemons restart ${label})` : r;

const STATUS_REASON: Partial<Record<StopResult['status'], string>> = {
	killed: 'SIGKILL after 5s',
	gone: 'already gone',
	'still-running': 'still running 5s after SIGTERM — rerun with --force'
};

/** Results and tree refusals as disk-style items, so the exit table is disk's. */
export function toItems(res: StopResponse, names: Map<number, string>): ItemReport[] {
	const label = (pid: number, name?: string) => `${pid}${name ? ` ${name}` : ''}`;
	return [
		...res.results.map((r) => ({
			item: label(r.pid, names.get(r.pid)),
			outcome: OUTCOME[r.status],
			reason: r.refusal ? refusalText(r.refusal, r.label) : STATUS_REASON[r.status]
		})),
		...res.skipped.map((s) => ({ item: label(s.pid, s.name), outcome: 'refused' as const, reason: refusalText(s.refusal, s.label) }))
	];
}

export function renderPreview(res: StopResponse, items: ItemReport[]): string {
	const cut = (s: string) => (s.length > 80 ? `${s.slice(0, 79)}…` : s);
	const ending = res.wouldEnd.map((p) => `  ${String(p.pid).padEnd(7)} ${p.kind.padEnd(8)} ${p.name}  ${cut(p.command)}`);
	const refused = items.filter((i) => i.outcome !== 'done');
	return [
		`would stop ${res.wouldEnd.length}:`,
		...ending,
		...(refused.length ? [`not stopping ${refused.length}:`, renderItems(refused)] : [])
	].join('\n');
}

async function find(target: string, snap: ProcessSnapshot, all: boolean): Promise<NamedTarget[]> {
	const kind = targetKind(target);
	if (kind === 'port') {
		const { listeners } = await apiGet<{ listeners: ListenerRef[] }>('/api/ports/listeners');
		return portTargets(listeners, Number(target.slice(1)));
	}
	if (kind === 'pid') return pidTargets(snap, Number(target));
	const { targets, candidates } = projectTargets(snap, target, all);
	if (candidates.length > 1) die(`"${target}" matches processes of ${candidates.length} projects:\n  ${candidates.join('\n  ')}`);
	return targets;
}

/** What `target` means, split into what may stop and this command's own process tree (`own`). */
async function resolve(target: string, all = false): Promise<{ targets: NamedTarget[]; own: NamedTarget[] }> {
	const snap = await apiGet<ProcessSnapshot>('/api/processes?all=1&fresh=1');
	const found = await find(target, snap, all);
	// This Mac's own `ps`, taken now: a fresh snapshot can join a build that started before the calling shell.
	const ps = Bun.spawnSync(['ps', '-axo', 'pid=,ppid=']).stdout.toString().trim().split('\n');
	const self = ancestry(new Map(ps.map((l) => l.trim().split(/\s+/).map(Number) as [number, number])), process.pid, process.ppid);
	return { targets: found.filter((t) => !self.has(t.pid)), own: found.filter((t) => self.has(t.pid)) };
}

/** `atlas kill` — resolve, dry-run, confirm, stop. Past target selection, the server does every safety check. */
export const kill: Command = {
	name: 'kill',
	summary: 'stop processes by pid, :port or project (always --dry-run first)',
	usage: USAGE,
	async run(args) {
		const { values, positionals } = parseArgs({
			args,
			allowPositionals: true,
			options: {
				tree: { type: 'boolean' },
				force: { type: 'boolean' },
				all: { type: 'boolean' },
				'dry-run': { type: 'boolean' },
				yes: { type: 'boolean' },
				json: { type: 'boolean' }
			}
		});
		if (positionals.length !== 1) die(USAGE);
		await requireUp();
		const { targets: named, own } = await resolve(positionals[0], values.all);
		if (own.length) console.error(`skipping ${own.map((t) => `${t.pid} ${t.name}`).join(', ')}: this command or the shell/session running it`);
		if (!named.length) {
			if (!own.length) console.error(`Nothing matches ${positionals[0]}. See: atlas ps --all`);
			if (values.json) console.log(JSON.stringify({ dryRun: true, generatedAt: new Date().toISOString(), results: [], wouldEnd: [], skipped: [] } satisfies StopResponse));
			return void (process.exitCode = own.length ? EXIT.refused : EXIT.nothing);
		}
		const names = new Map(named.map((t) => [t.pid, t.name]));
		const body: StopRequest = { targets: named.map(({ pid, startedAt }) => ({ pid, startedAt })), tree: values.tree, force: values.force };
		const preview = await apiPost<StopResponse>('/api/processes/stop', { ...body, dryRun: true });
		const planned = toItems(preview, names);
		if (values['dry-run']) {
			console.log(values.json ? JSON.stringify(preview) : renderPreview(preview, planned));
			return void (process.exitCode = EXIT[exitFor({ command: 'kill', items: planned })]);
		}
		console.error(renderPreview(preview, planned));
		if (!preview.wouldEnd.length) {
			if (values.json) console.log(JSON.stringify(preview));
			return void (process.exitCode = EXIT[exitFor({ command: 'kill', items: planned })]);
		}
		if (!values.yes && !process.stdin.isTTY) {
			console.error(`refused: no terminal to confirm — rerun with --yes to stop ${preview.wouldEnd.length} process(es)`);
			return void (process.exitCode = EXIT.refused);
		}
		if (!values.yes && !(await confirm(`Stop ${preview.wouldEnd.length} process(es)?`))) {
			console.error('declined');
			return void (process.exitCode = EXIT.refused);
		}
		const result = await apiPost<StopResponse>('/api/processes/stop', { ...body, dryRun: false });
		const items = toItems(result, names);
		console.log(values.json ? JSON.stringify(result) : renderItems(items));
		process.exitCode = EXIT[exitFor({ command: 'kill', items })];
	}
};
