/** Static assets for `agent-log init`: the ./agent-log shim and the CLAUDE.md policy block. */
import { OPERATIONS } from './args';

export const ATLAS_REPO = 'https://github.com/doublej/project-atlas';

export const SHIM_CONTENT = `#!/bin/sh
# Shipped by project-atlas — ${ATLAS_REPO}
exec atlas agent-log "$@"
`;

export const MARKER = '<!-- agent-log:policy -->';

export const POLICY_BLOCK = `${MARKER}
### Shared agent journal

Use \`./agent-log\` (a shim for \`atlas agent-log\` — both are identical) for short-lived
operational awareness between concurrent agents. It is not chat and not a task tracker: the
issue tracker remains the source of truth for ownership, blockers, and durable findings.

- Run \`./agent-log recent\` before interpreting shared state.
- Before an action that can change another agent's observations, write an intent with every
  affected scope. This includes shared-worktree edits, generated artifacts, git/index
  mutations, and shared ports, processes, or services.
- Run builds, tests, and deployments through the wrapper so start, commit, dirty state,
  duration, exit code, and outcome are recorded even on failure:
  \`./agent-log run build|test|deploy --scope <resource> [--bead <id>] -- <command...>\`.
- For manual operations, use \`./agent-log begin <operation> --scope <resource> [--bead <id>]
  -- <summary>\` and always close the returned id with \`./agent-log end <id> --outcome
  ok|failed|cancelled -- <result>\`. \`<operation>\` is one of ${OPERATIONS.join(', ')} — what
  makes this particular run specific goes in the summary, never in an invented operation name.
- Record a temporary result-affecting discovery with \`./agent-log finding --scope <resource>
  --evidence <fact> [--bead <id>] -- <summary>\`. This is the entry that saves another agent a
  wasted run, and the one most often skipped — write one whenever you learn something that
  would change what a concurrent agent does next, especially a dead end. Promote lasting
  knowledge to the issue tracker or the relevant doc.
- At session end, write \`./agent-log handoff -- <stopping point + next step>\` — the durable
  baton the next session's briefing picks up. Handoffs never expire; the latest one is
  always shown by \`recent\`.
- Intents expire after 20 minutes and findings after 4 hours unless \`--ttl\` overrides them.
  Renew by closing and reopening an intent; never treat an expired entry as current.
- Keep summaries factual and short. Do not reply, ask questions, mention agents, narrate
  routine progress, or log isolated reads/edits/tests that cannot affect anyone else.

Canonical scopes are \`path:<repo-relative-path>\`, \`artifact:<name>\`, \`service:<name>\`,
\`host:<name>\`, \`port:<number>\`, and \`git:<worktree-or-ref>\`; a repo may define additional
canonical scopes of its own. Add multiple \`--scope\` flags when needed. The journal SQLite db
lives in the git common directory, so linked worktrees share it without dirtying the repo.
`;
