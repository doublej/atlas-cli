import type { Command } from '../types';
import { USAGE, die, splitArgs } from '../agent-log/args';
import { begin, end, finding, handoff } from '../agent-log/events';
import { bootstrapJournal } from '../agent-log/init';
import { openConsole } from '../agent-log/mirror';
import { recent } from '../agent-log/render';
import { runWrapped } from '../agent-log/run';
import { sessionEnd } from '../agent-log/session-end';

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

Env: ATLAS_AGENT_LOG_PATH overrides the journal db location.`;

/** `atlas agent-log <recent|begin|finding|end|run|init>` — the shared agent journal. */
export const agentLog: Command = {
	name: 'agent-log',
	summary: 'shared agent journal — recent/begin/finding/end/run/init',
	async run(args) {
		const [sub, ...rest] = args;
		if (!sub || sub === 'help' || sub === '--help') return console.log(HELP);
		if (sub === 'init') return bootstrapJournal(process.cwd());
		if (sub === 'console') return openConsole();
		if (sub === 'session-end') return sessionEnd();
		// agent-log's option parser requires values after every flag — strip the
		// value-less --json before it ever sees the args.
		const asJson = rest.includes('--json');
		const parsed = splitArgs(rest.filter((arg) => arg !== '--json'));
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
