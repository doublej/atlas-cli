import type { Command } from '../types';
import { apiGet } from '../api';
import { die, requireUp, resolveRoot } from '../util';

/** The subset of `Project` (atlas-api/src/lib/scanner.ts) this command prints. */
export interface InfoProject {
	name: string;
	slug: string;
	path: string;
	relativePath: string;
	description?: string;
	type?: string;
	framework?: string;
	runner?: string;
	port?: number;
	git?: string;
	gitBranch?: string;
	flow?: { policy: string; trunk: string; integration?: string; drift?: string };
	devCommand?: string;
	scripts?: Record<string, string>;
	justRecipes?: string[];
	deploy?: { platform: string; url?: string }[];
	domains?: string[];
	umami?: { websiteIds: string[]; instance?: string };
	beads?: { open: number; inProgress: number; closed: number };
	claudeSessions?: { lastAt: string; count: number; summary?: string };
	agentFiles?: { claude?: { tokens: number }; agents?: { tokens: number } };
	claudeSetup?: {
		mcpServers?: string[];
		mcpDisabled?: string[];
		agents?: number;
		commands?: number;
		skills?: number;
		rules?: number;
		hooks?: string[];
		settings?: string[];
	};
	archived?: boolean;
	modifiedAt?: string;
}

const list = (xs: string[], max = 8): string =>
	xs.slice(0, max).join(', ') + (xs.length > max ? `, +${xs.length - max} more` : '');

const ago = (iso: string): string => {
	const days = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
	return days <= 0 ? 'today' : days === 1 ? '1d ago' : `${days}d ago`;
};

const plural = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`;

/** `8659` → `~8.7k`. */
const tokens = (n: number): string => (n >= 1000 ? `~${(n / 1000).toFixed(1)}k` : `~${n}`);

/** One line for the Claude Code setup: context size, then what `.claude/` carries. */
export function claudeLine(p: InfoProject): string | undefined {
	const s = p.claudeSetup;
	const parts = [
		p.agentFiles?.claude && `CLAUDE.md ${tokens(p.agentFiles.claude.tokens)}`,
		p.agentFiles?.agents && `AGENTS.md ${tokens(p.agentFiles.agents.tokens)}`,
		s?.agents && plural(s.agents, 'agent'),
		s?.commands && plural(s.commands, 'command'),
		s?.skills && plural(s.skills, 'skill'),
		s?.rules && plural(s.rules, 'rule'),
		s?.hooks?.length && `hooks: ${s.hooks.join(', ')}`,
		s?.settings?.length && `${s.settings.join(' + ')} settings`
	].filter(Boolean) as string[];
	return parts.length > 0 ? parts.join(' · ') : undefined;
}

/** MCP servers scoped to this project, marking the ones switched off. */
export function mcpLine(p: InfoProject): string | undefined {
	const servers = p.claudeSetup?.mcpServers;
	if (!servers?.length) return undefined;
	const off = new Set(p.claudeSetup?.mcpDisabled ?? []);
	return servers.map((n) => (off.has(n) ? `${n} (off)` : n)).join(', ');
}

function render(p: InfoProject, hostname?: string): string[] {
	const row = (label: string, value?: string) => (value ? `  ${label.padEnd(12)} ${value}` : '');
	const stack = [p.type, p.framework, p.runner].filter((v) => v && v !== 'unknown').join(' · ');
	const flow = p.flow && [p.flow.policy, p.flow.trunk, p.flow.integration].filter(Boolean).join(' → ');
	return [
		`${p.name}${p.archived ? '  (archived)' : ''}  —  ${p.relativePath}`,
		p.description ? `  ${p.description}` : '',
		'',
		row('stack', stack),
		row('port', p.port ? String(p.port) : undefined),
		row('hostname', hostname),
		row('branch', p.gitBranch && `${p.gitBranch}${p.git === 'dirty' ? ' (dirty)' : ''}`),
		row('flow', flow && `${flow}${p.flow?.drift ? `  ⚠ ${p.flow.drift}` : ''}`),
		row('dev', p.devCommand),
		row('scripts', p.scripts && list(Object.keys(p.scripts))),
		row('just', p.justRecipes?.length ? list(p.justRecipes) : undefined),
		row('deploy', p.deploy?.map((d) => d.url ?? d.platform).join(', ')),
		row('domains', p.domains?.length ? list(p.domains) : undefined),
		row('umami', p.umami?.websiteIds.length && p.umami.instance
			? `${p.umami.instance}/websites/${p.umami.websiteIds[0]}`
			: undefined),
		row('beads', p.beads && `${p.beads.open} open · ${p.beads.inProgress} in progress · ${p.beads.closed} closed`),
		row('sessions', p.claudeSessions && `${p.claudeSessions.count} · last ${ago(p.claudeSessions.lastAt)}`),
		row('claude', claudeLine(p)),
		row('mcp', mcpLine(p)),
		row('modified', p.modifiedAt && ago(p.modifiedAt))
	].filter((line) => line !== '');
}

/** The scanned project owning `root`: an exact match, else the nearest ancestor. */
export const projectFor = (projects: InfoProject[], root: string): InfoProject | undefined =>
	projects
		.filter((p) => root === p.path || root.startsWith(`${p.path}/`))
		.sort((a, b) => b.path.length - a.path.length)[0];

/** `atlas info [path]` — what atlas knows about the current project. */
export const info: Command = {
	name: 'info',
	summary: "show atlas's record for the current project",
	async run(args) {
		const json = args.includes('--json');
		const root = resolveRoot(args.find((a) => !a.startsWith('-')));
		await requireUp();
		const { projects } = await apiGet<{ projects: InfoProject[] }>(
			'/api/projects?includeArchived=true'
		);
		const project = projectFor(projects, root);
		if (!project) die(`No scanned project at ${root}. Run: atlas scan`);

		const hostnames = await apiGet<{ slug: string; local: string }[]>('/api/hostnames').catch(
			() => []
		);
		const hostname = hostnames.find((h) => h.slug === project.slug)?.local;

		console.log(
			json ? JSON.stringify({ ...project, hostname }, null, 2) : render(project, hostname).join('\n')
		);
	}
};
