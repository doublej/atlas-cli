// Pure renderer for `atlas brief` — no API, no I/O (tree-format.ts pattern).
// The command gathers BriefData from local sources; this module only formats it.

export interface BriefData {
	project: string;
	session?: { count: number; lastAt: string; sessionId: string; summary?: string };
	handoff?: { summary: string; atMs: number; auto: boolean };
	journal?: { activeIntents: number; findings: number };
	coordination?: {
		mode: string;
		boundary: string;
		activeSessions: number;
		liveLeases: number;
		openTasks: number;
		task?: string;
	};
	beads?: { open: number; inProgress: number; closed: number };
	claudeMd?: { tokens: number; modifiedAt: string; staleSinceSessions: boolean };
	board: { posts: number; latest: { at: string; author: string; text: string }[] };
}

/** Token count → `2.3k` past a thousand, else the bare number. */
const fmtTokens = (n: number): string => (n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n));

/** Human age of a past instant: "just now", "5m ago", "3h ago", "12d ago". */
export function formatAge(thenMs: number, nowMs: number): string {
	const minutes = Math.floor((nowMs - thenMs) / 60_000);
	if (minutes < 1) return 'just now';
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	return `${Math.floor(hours / 24)}d ago`;
}

/** Session briefing block — absent sections are simply omitted. */
export function renderBrief(data: BriefData, nowMs: number): string {
	const age = (ms: number): string => formatAge(ms, nowMs);
	const lines = [`atlas brief — ${data.project}`];
	if (data.session) {
		const s = data.session;
		const summary = s.summary ? ` · ${s.summary}` : '';
		lines.push(`  sessions:  ${s.count} · last ${age(Date.parse(s.lastAt))}${summary}`);
		lines.push(`  resume:    claude --resume ${s.sessionId}`);
	}
	if (data.handoff) {
		const tag = data.handoff.auto ? 'auto, ' : '';
		lines.push(`  handoff:   ${data.handoff.summary} (${tag}${age(data.handoff.atMs)})`);
	}
	if (data.journal && (data.journal.activeIntents > 0 || data.journal.findings > 0)) {
		lines.push(
			`  journal:   ${data.journal.activeIntents} active intents · ${data.journal.findings} findings — run \`atlas agent-log recent\``
		);
	}
	if (data.coordination) {
		const task = data.coordination.task ? ` · task: ${data.coordination.task}` : '';
		lines.push(
			`  coord:     ${data.coordination.mode} (${data.coordination.boundary}) · ${data.coordination.activeSessions} session(s) · ${data.coordination.liveLeases} lease(s) · ${data.coordination.openTasks} open task(s)${task}`
		);
	}
	if (data.beads && (data.beads.open > 0 || data.beads.inProgress > 0)) {
		lines.push(
			`  beads:     ${data.beads.open} open · ${data.beads.inProgress} in progress · ${data.beads.closed} closed`
		);
	}
	if (data.claudeMd) {
		const edited = `edited ${age(Date.parse(data.claudeMd.modifiedAt))}`;
		const stale = data.claudeMd.staleSinceSessions ? ' — stale vs recent sessions' : '';
		lines.push(`  claude.md: ~${fmtTokens(data.claudeMd.tokens)} tokens · ${edited}${stale}`);
	}
	{
		const ask = 'post before you finish: `atlas board post --re "<subject>" "…"`';
		lines.push(`  board:     ${data.board.posts ? `${data.board.posts} posts (\`atlas board\`)` : 'empty, be the first'} · ${ask}`);
		for (const post of data.board.latest) {
			const text = post.text.replace(/\s+/g, ' ');
			const short = text.length > 120 ? text.slice(0, 119) + '…' : text;
			lines.push(`             ${age(Date.parse(post.at))} ${post.author}: ${short}`);
		}
	}
	lines.push('  primer:    `atlas prime` — workflows, guardrails');
	return lines.join('\n');
}
