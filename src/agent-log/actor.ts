/** Actor identity for journal events — must distinguish concurrent agents in the same repo. */
import { basename } from 'node:path';

type ProcInfo = { ppid: number; comm: string };

function procInfo(pid: number): ProcInfo | null {
	const result = Bun.spawnSync(['ps', '-o', 'ppid=,comm=', '-p', String(pid)], {
		stderr: 'ignore'
	});
	if (result.exitCode !== 0) return null;
	const match = /^\s*(\d+)\s+(.*)$/.exec(result.stdout.toString().trim());
	return match ? { ppid: Number(match[1]), comm: basename(match[2]) } : null;
}

/** Nearest claude/codex ancestor, as `comm-pid` — one stable id per agent session. */
function agentAncestor(): string | null {
	let pid = process.ppid;
	for (let depth = 0; depth < 15 && pid > 1; depth += 1) {
		const info = procInfo(pid);
		if (!info) return null;
		if (/^(claude|codex)/.test(info.comm)) return `${info.comm}-${pid}`;
		pid = info.ppid;
	}
	return null;
}

const UUID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

/**
 * Session ids arrive as bare UUIDs, which are unreadable in `recent` and, for UUIDv7, share a
 * leading timestamp — agents started within the same ~65s render identically on any prefix.
 * Keep the random tail, which stays distinct; pass human-set ids through untouched.
 */
function shortenAgentId(id: string): string {
	return UUID.test(id) ? id.slice(-8) : id;
}

/** Always `<agent>@<repo>`, whichever way the agent identified itself. */
export function currentActor(): string {
	const named = process.env.AGENT_ID ?? process.env.CLAUDE_AGENT_ID ?? process.env.CODEX_THREAD_ID;
	const agent = named ? shortenAgentId(named) : (agentAncestor() ?? process.env.USER ?? 'agent');
	return `${agent}@${basename(process.cwd())}`;
}
