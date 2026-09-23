/**
 * `atlas brief` — session briefing for the current project, built only from local
 * sources (~/.claude/projects, .atlas-cache.json, the agent journal). No API calls.
 * Wired as a global SessionStart hook, so it must never throw and must stay silent
 * outside recognized project dirs (exit 0, no output).
 */
import { existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { Database } from 'bun:sqlite';
import type { Command } from '../types';
import { DEV_FOLDER } from '../template-discovery';
import { parseRow, visibleRows } from '../agent-log/render';
import { loadEvents } from '../agent-log/store';
import { journalPath } from '../agent-log/schema';
import { resolveWorkspace } from '../agent-log/project';
import { installHook } from '../hooks';
import { renderBrief, type BriefData } from '../brief-format';
import { readPosts } from './board';

type CachedProject = {
	path: string;
	beads?: BriefData['beads'];
	claudeSessions?: { lastAt: string; count: number; summary?: string };
};

async function readSessions(root: string): Promise<BriefData['session'] | undefined> {
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

/** Coordination state via the `status` contract — never creates the journal. */
function readCoordination(root: string): BriefData['coordination'] | undefined {
	const workspace = resolveWorkspace(root);
	if (!workspace) return undefined;
	const path = journalPath(workspace);
	if (!existsSync(path)) return undefined;
	try {
		const db = new Database(path, { readonly: true });
		try {
			const now = Date.now();
			const sessions = (
				db.query("SELECT COUNT(*) AS n FROM sessions WHERE status = 'active'").get() as { n: number }
			).n;
			const leases = (
				db.query('SELECT COUNT(*) AS n FROM leases WHERE expires_ms > ?').get(now) as { n: number }
			).n;
			const tasks = (
				db.query("SELECT COUNT(*) AS n FROM tasks WHERE status = 'open'").get() as { n: number }
			).n;
			const task = db
				.query("SELECT title FROM tasks WHERE status = 'open' ORDER BY opened_at DESC LIMIT 1")
				.get() as { title: string } | null;
			return { mode: workspace.mode, boundary: workspace.boundary, activeSessions: sessions, liveLeases: leases, openTasks: tasks, task: task?.title };
		} finally {
			db.close();
		}
	} catch {
		return undefined;
	}
}

/** Journal counts + latest handoff (manual preferred). Reads only an existing db. */
function readJournal(root: string): { journal?: BriefData['journal']; handoff?: BriefData['handoff'] } {
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

async function readClaudeMd(root: string, lastSessionAt?: string): Promise<BriefData['claudeMd']> {
	try {
		const path = join(root, 'CLAUDE.md');
		const [content, stats] = await Promise.all([readFile(path, 'utf-8'), stat(path)]);
		const staleSinceSessions = lastSessionAt
			? stats.mtimeMs < Date.parse(lastSessionAt) - STALE_MARGIN_MS
			: false;
		return {
			// ~2.5 chars/token — mirrors estimateTokens in atlas-api's claude-tree.ts,
			// calibrated against Claude Code's /context figures for CLAUDE.md files
			tokens: Math.round(content.length / 2.5),
			modifiedAt: new Date(stats.mtimeMs).toISOString(),
			staleSinceSessions
		};
	} catch {
		return undefined;
	}
}

async function gather(root: string): Promise<BriefData | undefined> {
	const [session, cached] = await Promise.all([readSessions(root), readCacheProject(root)]);
	if (!session && !cached) return undefined; // not a recognized project dir
	if (session && cached?.claudeSessions?.summary) session.summary = cached.claudeSessions.summary;
	const data: BriefData = { project: basename(root), session, board: { posts: 0, latest: [] } };
	Object.assign(data, readJournal(root));
	data.coordination = readCoordination(root);
	if (cached?.beads) data.beads = cached.beads;
	data.claudeMd = await readClaudeMd(root, session?.lastAt);
	const posts = readPosts();
	data.board = { posts: posts.length, latest: posts.slice(-3) };
	return data;
}

function installGlobalHooks(): void {
	const settingsPath = join(homedir(), '.claude', 'settings.json');
	const added =
		Number(installHook(settingsPath, 'SessionStart', 'atlas brief')) +
		Number(installHook(settingsPath, 'SessionEnd', 'atlas agent-log session-end'));
	console.log(added > 0 ? `installed ${added} hook(s) in ${settingsPath}` : 'hooks already installed');
}

/** `atlas brief [--json|--install-hook]` — brief a session on where this project stands. */
export const brief: Command = {
	name: 'brief',
	summary: 'session briefing: last session, handoff, journal, beads',
	async run(args) {
		if (args.includes('--install-hook')) return installGlobalHooks();
		try {
			const data = await gather(process.cwd());
			if (!data) return;
			console.log(args.includes('--json') ? JSON.stringify(data) : renderBrief(data, Date.now()));
		} catch {
			// a briefing must never break a session start
		}
	}
};
