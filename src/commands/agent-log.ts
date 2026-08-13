import type { Command } from '../types';
import { USAGE, die, parseDuration, splitArgs } from '../agent-log/args';
import { begin, end, finding, handoff } from '../agent-log/events';
import { bootstrapJournal } from '../agent-log/init';
import { openConsole } from '../agent-log/mirror';
import { recent } from '../agent-log/render';
import { runWrapped } from '../agent-log/run';
import { boundaryActor } from '../agent-log/actor';
import { resolveWorkspace, type Workspace } from '../agent-log/project';
import { claimScopes } from '../agent-log/leases';
import { releaseScopes, renewLeases } from '../agent-log/lifecycle';
import { sessionIdFor } from '../agent-log/sessions';
import { gatherStatus, renderStatus } from '../agent-log/status';
import { runDoctor } from '../agent-log/doctor';
import { runHookEvent } from '../agent-log/hook-run';
import { parseHookInput, type Harness } from '../agent-log/hooks';
import { checkpointEvent } from '../agent-log/transitions';
import { guardCommand, guardFinished } from '../agent-log/guard';
import { runGc } from '../agent-log/gc';
import { openJournal } from '../agent-log/schema';

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
  renew     renew the session's live leases (heartbeat + expiry)
  checkpoint  structured handoff state: --done --next --blocked
  guard     lease-aware wrapper: claim derived scopes, run, release
  hook      harness hook adapter (Claude Code + Codex JSON on stdin)
  gc        retention sweep for telemetry, expired leases, closed sessions
  doctor    schema version, hook coverage, stale sessions, aliases, clock

Env: ATLAS_AGENT_LOG_PATH overrides the journal db location.`;

function requireWorkspace(): Workspace {
	const workspace = resolveWorkspace(process.cwd());
	if (!workspace) die('agent-log: no project boundary here (no .atlas, no git repo)');
	return workspace;
}

function sessionId(workspace: Workspace, parsed: ReturnType<typeof splitArgs>): string {
	return sessionIdFor(workspace, boundaryActor(workspace.root), parsed.options.get('--session')?.[0]);
}

/** `atlas agent-log <sub>` — the shared agent journal + coordination state. */
export const agentLog: Command = {
	name: 'agent-log',
	summary: 'shared agent journal — recent/begin/finding/end/run + status/claim/release/renew/checkpoint/guard/hook/gc/doctor',
	async run(args) {
		const [sub, ...rest] = args;
		if (!sub || sub === 'help' || sub === '--help') return console.log(HELP);
		if (sub === 'init') return bootstrapJournal(process.cwd());
		if (sub === 'console') return openConsole();
		if (sub === 'session-end') {
			try {
				const raw = JSON.parse(await Bun.stdin.text()) as Record<string, unknown>;
				runHookEvent(parseHookInput('claude', 'SessionEnd', raw));
			} catch {
				// a broken journal must never break ending a session
			}
			return;
		}
		if (sub === 'doctor') {
			const report = runDoctor(requireWorkspace());
			console.log(`atlas agent-log doctor\n${report.lines.join('\n')}`);
			process.exit(report.ok ? 0 : 1);
		}
		if (sub === 'hook') {
			try {
				const event = rest[0] ?? '';
				const harness: Harness = rest[1] === '--harness' ? (rest[2] as Harness) : 'claude';
				const raw = JSON.parse(await Bun.stdin.text()) as Record<string, unknown>;
				const decision = runHookEvent(parseHookInput(harness, event, raw));
				if (decision.context)
					console.log(JSON.stringify({ additionalContext: decision.context }));
				else if (decision.block !== undefined)
					console.log(
						JSON.stringify(
							harness === 'codex'
								? { block: decision.block, reason: decision.reason ?? '' }
								: { decision: decision.block ? 'block' : 'allow', reason: decision.reason ?? '' }
						)
					);
			} catch {
				// hooks must never break the harness
			}
			return;
		}
		if (sub === 'gc') {
			const workspace = requireWorkspace();
			console.log(
				`atlas agent-log gc — ${workspace.root}\n${runGc(workspace, rest.includes('--dry-run')).join('\n')}`
			);
			return;
		}
		if (sub === 'checkpoint') {
			const workspace = requireWorkspace();
			const parsed = splitArgs(rest);
			const id = sessionId(workspace, parsed);
			const db = openJournal(workspace);
			try {
				checkpointEvent(db, {
					workspace,
					sessionId: id,
					done: parsed.options.get('--done')?.join(' '),
					next: parsed.options.get('--next')?.join(' '),
					blocked: parsed.options.get('--blocked')?.join(' ')
				});
			} finally {
				db.close();
			}
			console.log('agent-log: checkpoint recorded');
			return;
		}
		if (sub === 'guard') {
			const workspace = requireWorkspace();
			const parsed = splitArgs(rest);
			const command = parsed.trailing;
			if (command.length === 0) die(`guard needs a command after '--'\n${USAGE}`);
			const outcome = guardCommand(
				workspace,
				command,
				parsed.options.get('--scope') ?? [],
				parsed.options.get('--session')?.[0]
			);
			if (outcome.block) die(outcome.reason ?? 'guard blocked');
			const child = Bun.spawn(command, { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' });
			const exitCode = await child.exited;
			guardFinished(
				workspace,
				parsed.options.get('--session')?.[0],
				command,
				parsed.options.get('--scope') ?? [],
				exitCode
			);
			process.exit(exitCode);
		}
		// agent-log's option parser requires values after every flag — strip the
		// value-less --json before it ever sees the args.
		const asJson = rest.includes('--json');
		const parsed = splitArgs(rest.filter((arg) => arg !== '--json'));
		if (sub === 'status') {
			const workspace = requireWorkspace();
			const data = gatherStatus(workspace, sessionId(workspace, parsed));
			console.log(asJson ? JSON.stringify(data) : renderStatus(data, Date.now()));
			return;
		}
		if (sub === 'claim') {
			const workspace = requireWorkspace();
			const rationale = parsed.trailing.join(' ');
			const scopes = parsed.positional;
			if (scopes.length === 0) die(`claim needs at least one scope\n${USAGE}`);
			if (!rationale) die(`claim needs a rationale after '--'\n${USAGE}`);
			try {
				const result = claimScopes({
					workspace,
					sessionId: sessionId(workspace, parsed),
					actor: boundaryActor(workspace.root),
					scopes,
					rationale,
					ttlMs: parseDuration(parsed.options.get('--ttl')?.[0] ?? '20m'),
					taskId: parsed.options.get('--task')?.[0],
					force: rest.includes('--force')
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
			const released = releaseScopes(workspace, sessionId(workspace, parsed), parsed.positional);
			console.log(`agent-log: released ${released} lease(s)`);
			return;
		}
		if (sub === 'renew') {
			const workspace = requireWorkspace();
			const renewed = renewLeases(
				workspace,
				sessionId(workspace, parsed),
				parseDuration(parsed.options.get('--ttl')?.[0] ?? '20m')
			);
			console.log(`agent-log: renewed ${renewed} lease(s)`);
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