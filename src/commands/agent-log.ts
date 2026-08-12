import type { Command } from '../types';
import { USAGE, die, parseDuration, splitArgs } from '../agent-log/args';
import { begin, end, finding, handoff } from '../agent-log/events';
import { bootstrapJournal } from '../agent-log/init';
import { openConsole } from '../agent-log/mirror';
import { recent } from '../agent-log/render';
import { runWrapped } from '../agent-log/run';
import { sessionEnd } from '../agent-log/session-end';
import { boundaryActor } from '../agent-log/actor';
import { resolveWorkspace, type Workspace } from '../agent-log/project';
import { claimScopes } from '../agent-log/leases';
import { releaseScopes } from '../agent-log/lifecycle';
import { sessionIdFor } from '../agent-log/sessions';
import { gatherStatus, renderStatus } from '../agent-log/status';
import { runDoctor } from '../agent-log/doctor';

const HELP = `atlas agent-log — shared agent journal for concurrent agents (SQLite in the git common dir)

${USAGE}

  recent    show live intents/findings, recent ends, and the latest handoff
  begin     open an intent (prints the op id); close it with \`end\`
  finding   record a temporary, evidence-backed discovery
  end       close an intent with --outcome ok|failed|cancelled
  handoff   durable session baton: stopping point + next step (never expires)
  session-end  Claude Code SessionEnd hook: auto handoff from hook JSON on stdin
  run       wrap build|deploy|test so outcome + exit code are journaled
  init      bootstrap this repo: ./agent-log shim, CLAUDE.md policy, journal db
  console   open the live mirror log (~/Library/Logs/atlas) in Console.app
  status    compact state snapshot: task, peers, owned/conflicting leases
  claim     acquire exclusive write leases for scopes (atomic, renewable)
  release   release the session's leases (all, or the given scopes)
  doctor    schema version, stale sessions, expired leases, aliases, clock

Env: ATLAS_AGENT_LOG_PATH overrides the journal db location.`;

function requireWorkspace(): Workspace {
	const workspace = resolveWorkspace(process.cwd());
	if (!workspace) die('agent-log: no project boundary here (no .atlas, no git repo)');
	return workspace;
}

/** `atlas agent-log <sub>` — the shared agent journal + coordination state. */
export const agentLog: Command = {
	name: 'agent-log',
	summary: 'shared agent journal — recent/begin/finding/end/run/init + status/claim/release/doctor',
	async run(args) {
		const [sub, ...rest] = args;
		if (!sub || sub === 'help' || sub === '--help') return console.log(HELP);
		if (sub === 'init') return bootstrapJournal(process.cwd());
		if (sub === 'console') return openConsole();
		if (sub === 'session-end') return sessionEnd();
		if (sub === 'doctor') {
			const report = runDoctor(requireWorkspace());
			console.log(`atlas agent-log doctor\n${report.lines.join('\n')}`);
			process.exit(report.ok ? 0 : 1);
		}
		// agent-log's option parser requires values after every flag — strip the
		// value-less --json before it ever sees the args.
		const asJson = rest.includes('--json');
		const parsed = splitArgs(rest.filter((arg) => arg !== '--json'));
		if (sub === 'status') {
			const workspace = requireWorkspace();
			const actor = boundaryActor(workspace.root);
			const data = gatherStatus(
				workspace,
				sessionIdFor(workspace, actor, parsed.options.get('--session')?.[0])
			);
			console.log(asJson ? JSON.stringify(data) : renderStatus(data, Date.now()));
			return;
		}
		if (sub === 'claim') {
			const workspace = requireWorkspace();
			const actor = boundaryActor(workspace.root);
			const rationale = parsed.trailing.join(' ');
			const scopes = parsed.positional;
			if (scopes.length === 0) die(`claim needs at least one scope\n${USAGE}`);
			if (!rationale) die(`claim needs a rationale after '--'\n${USAGE}`);
			try {
				const result = claimScopes({
					workspace,
					sessionId: sessionIdFor(workspace, actor, parsed.options.get('--session')?.[0]),
					actor,
					scopes,
					rationale,
					ttlMs: parseDuration(parsed.options.get('--ttl')?.[0] ?? '20m'),
					taskId: parsed.options.get('--task')?.[0]
				});
				if (!result.ok) {
					for (const conflict of result.conflicts)
						console.error(
							`agent-log: conflict on ${conflict.scope} — held by ${conflict.actor} (session ${conflict.sessionId}) until ${new Date(conflict.expiresMs).toISOString()}`
						);
					die('claim denied');
				}
				console.log(
					`agent-log: claimed ${result.leases.length} scope(s) for session ${result.leases[0]?.session_id ?? ''}`
				);
			} catch (error) {
				die(error instanceof Error ? error.message : String(error));
			}
			return;
		}
		if (sub === 'release') {
			const workspace = requireWorkspace();
			const actor = boundaryActor(workspace.root);
			const released = releaseScopes(
				workspace,
				sessionIdFor(workspace, actor, parsed.options.get('--session')?.[0]),
				parsed.positional
			);
			console.log(`agent-log: released ${released} lease(s)`);
			return;
		}
		if (sub === 'recent') return recent(parsed.options, asJson);
		if (sub === 'begin')
			return console.log(begin(parsed.positional[0], parsed.options, parsed.trailing.join(' ')));
		if (sub === 'finding') return finding(parsed.options, parsed.trailing.join(' '));
		if (sub === 'end')
			return end({
				opId: parsed.positional[0],
				outcome: parsed.options.get('--outcome')?.[0] ?? 'ok',
				summary: parsed.trailing.join(' ')
			});
		if (sub === 'handoff')
			return handoff(
				parsed.options,
				(parsed.trailing.length ? parsed.trailing : parsed.positional).join(' ')
			);
		if (sub === 'run') return runWrapped(parsed.positional[0], parsed.options, parsed.trailing);
		die(`unknown command '${sub}'\n${USAGE}`);
	}
};