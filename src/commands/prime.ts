/**
 * `atlas prime` — session briefing for the current project, built only from local
 * sources (~/.claude/projects, .atlas-cache.json, the agent journal). No API calls.
 * Wired as a global SessionStart hook, so it must never throw and must stay silent
 * outside recognized project dirs (exit 0, no output).
 */
import { existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import type { Command } from '../types';
import { DEV_FOLDER } from '../template-discovery';
import { parseRow, visibleRows } from '../agent-log/render';
import { loadEvents } from '../agent-log/store';
import { installHook } from '../hooks';
import { renderPrime, type PrimeData } from '../prime-format';

type CachedProject = {
	path: string;
	beads?: PrimeData['beads'];
	claudeSessions?: { lastAt: string; count: number; summary?: string };
};

async function readSessions(root: string): Promise<PrimeData['session'] | undefined> {
	const dir = join(homedir(), '.claude', 'projects', root.replace(/[^a-zA-Z0-9]/g, '-'));
	let names: string[];
	try {
		names = (await readdir(dir)).filter((name) => name.endsWith('.jsonl'));
	} catch {
		return undefined;
	}
	let lastAt = 0;
	let newest = '';
	for (const name of names) {
		try {
			const stats = await stat(join(dir, name));
			if (stats.isFile() && stats.mtimeMs > lastAt) {
				lastAt = stats.mtimeMs;
				newest = name;
			}
		} catch { /* vanished mid-read */ }
	}
	if (!newest) return undefined;
	return {
		count: names.length,
		lastAt: new Date(lastAt).toISOString(),
		sessionId: basename(newest, '.jsonl')
	};
}

async function readCacheProject(root: string): Promise<CachedProject | undefined> {
	try {
		const raw = await readFile(join(DEV_FOLDER, '.atlas-cache.json'), 'utf-8');
		const cache = JSON.parse(raw) as { projects?: CachedProject[] };
		return cache.projects?.find((project) => project.path === root);
	} catch {
		return undefined;
	}
}

/** Journal counts + latest handoff (manual preferred). Reads only an existing db. */
function readJournal(root: string): { journal?: PrimeData['journal']; handoff?: PrimeData['handoff'] } {
	const probe = Bun.spawnSync(
		['git', '-C', root, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
		{ stderr: 'ignore' }
	);
	if (probe.exitCode !== 0) return {};
	const db = process.env.ATLAS_AGENT_LOG_PATH ?? join(probe.stdout.toString().trim(), 'agent-log.sqlite');
	if (!existsSync(db)) return {}; // never create a journal as a side effect of a briefing
	try {
		const visible = visibleRows(new Map());
		const journal = {
			activeIntents: visible.filter((row) => row.kind === 'intent').length,
			findings: visible.filter((row) => row.kind === 'finding').length
		};
		const handoffs = loadEvents().filter((row) => row.kind === 'handoff').map(parseRow);
		const manual = handoffs.filter((row) => !row.detail.auto);
		const chosen = (manual.length ? manual : handoffs).at(-1);
		const handoff = chosen
			? { summary: chosen.summary, atMs: chosen.at_ms, auto: Boolean(chosen.detail.auto) }
			: undefined;
		return { journal, handoff };
	} catch {
		return {};
	}
}

const STALE_MARGIN_MS = 7 * 24 * 3_600_000;

async function readClaudeMd(root: string, lastSessionAt?: string): Promise<PrimeData['claudeMd']> {
	try {
		const path = join(root, 'CLAUDE.md');
		const [content, stats] = await Promise.all([readFile(path, 'utf-8'), stat(path)]);
		const staleSinceSessions = lastSessionAt
			? stats.mtimeMs < Date.parse(lastSessionAt) - STALE_MARGIN_MS
			: false;
		return {
			tokens: Math.round(content.length / 4),
			modifiedAt: new Date(stats.mtimeMs).toISOString(),
			staleSinceSessions
		};
	} catch {
		return undefined;
	}
}

async function gather(root: string): Promise<PrimeData | undefined> {
	const [session, cached] = await Promise.all([readSessions(root), readCacheProject(root)]);
	if (!session && !cached) return undefined; // not a recognized project dir
	if (session && cached?.claudeSessions?.summary) session.summary = cached.claudeSessions.summary;
	const data: PrimeData = { project: basename(root), session };
	Object.assign(data, readJournal(root));
	if (cached?.beads) data.beads = cached.beads;
	data.claudeMd = await readClaudeMd(root, session?.lastAt);
	return data;
}

function installGlobalHooks(): void {
	const settingsPath = join(homedir(), '.claude', 'settings.json');
	const added =
		Number(installHook(settingsPath, 'SessionStart', 'atlas prime')) +
		Number(installHook(settingsPath, 'SessionEnd', 'atlas agent-log session-end'));
	console.log(added > 0 ? `installed ${added} hook(s) in ${settingsPath}` : 'hooks already installed');
}

/** `atlas prime [--json|--install-hook]` — brief a session on where this project stands. */
export const prime: Command = {
	name: 'prime',
	summary: 'session briefing: last session, handoff, journal, beads',
	async run(args) {
		if (args.includes('--install-hook')) return installGlobalHooks();
		try {
			const data = await gather(process.cwd());
			if (!data) return;
			console.log(args.includes('--json') ? JSON.stringify(data) : renderPrime(data, Date.now()));
		} catch {
			// a briefing must never break a session start
		}
	}
};
