import { parseArgs } from 'node:util';
import type { Command } from '../types';
import { apiGet } from '../api';
import { requireUp } from '../util';
import type { InfoProject } from './info';

const USAGE = `Usage: atlas agents [mcp|cli] [query] [--json]   the register of agent interfaces

One row per MCP server or agent-ready CLI a project ships. Detected from the project's files:
an MCP SDK dependency, or a bin whose entry point or README/CLAUDE.md/AGENTS.md mentions --json
or a \`prime\` command. Correct a wrong guess in the project's .atlas, which replaces detection:
  atlas set agentInterfaces "cli:atlas mcp:deckhand"     ([] clears it)`;

export interface AgentRow {
	kind: 'cli' | 'mcp';
	name: string;
	project: string;
	path: string;
	host: string;
}

/** Flatten projects into register rows, MCP first, then by name. */
export function agentRows(projects: InfoProject[]): AgentRow[] {
	return projects
		.flatMap((p) =>
			(p.agentInterfaces ?? []).map((i) => ({ ...i, project: p.relativePath, path: p.path, host: p.host ?? '' }))
		)
		.sort((a, b) => b.kind.localeCompare(a.kind) || a.name.localeCompare(b.name));
}

/** `atlas agents` — every MCP server and agent-ready CLI in the catalog. */
export const agents: Command = {
	name: 'agents',
	summary: 'the register of MCP servers and agent-ready CLIs across projects',
	usage: USAGE,
	async run(args) {
		const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { json: { type: 'boolean' } } });
		const kind = positionals[0] === 'mcp' || positionals[0] === 'cli' ? positionals.shift() : undefined;
		const query = positionals.join(' ').toLowerCase();
		await requireUp();
		const { projects } = await apiGet<{ projects: InfoProject[] }>('/api/projects');
		const rows = agentRows(projects).filter(
			(r) => (!kind || r.kind === kind) && (!query || `${r.name} ${r.project}`.toLowerCase().includes(query))
		);
		if (values.json) return console.log(JSON.stringify(rows));
		if (rows.length === 0) return console.log('No agent interfaces match.');
		for (const r of rows) console.log(`${r.kind}  ${r.name.padEnd(28)} ${r.project}${r.host && r.host !== 'm2' ? `  (${r.host})` : ''}`);
	}
};
