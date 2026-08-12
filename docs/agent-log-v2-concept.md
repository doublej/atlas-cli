# Agent Log v2: coordination, not narration

## Outcome

Make Agent Log the small coordination kernel every harness consults before side effects. Agents
should not need to remember to narrate routine work. Atlas should derive project, session, task,
and write scope; warn or block only when another live actor can be affected; and leave a compact,
useful baton when work stops.

Success means two agents can safely work in parallel without reading a transcript, while a new
session can answer what is attempted, owned, evidenced, changed, blocked, and next.

## What the current design gets right—and where it stops

| Keep | Gap to close |
| --- | --- |
| SQLite in the Git common dir | Free-form scopes are labels, not conflict-detectable resources |
| Append-only intent/finding/end/handoff events | Current state must be reconstructed and read paths duplicate policy |
| TTLs and WAL concurrency | TTL is not a renewable lease; expiry can hide still-running work |
| `atlas prime` and SessionEnd | Hooks cover briefing/exit, not edits, tools, compaction, or subagents |
| Build/test/deploy wrapper | Only commands agents remember to wrap are visible |
| Worktree-shared storage | The nearest Git repo is not always the intended Atlas workspace |

The observed journal has one generic handoff: optional manual logging is not yet valuable enough to become habitual.

## Proposed shape

```text
harness events -> adapter -> project resolver -> scope/lease guard -> SQLite
                                    |                 |              |
                              .atlas boundary    allow/warn/deny   state + audit
                                    |                 |              |
                               status/prime <---- compact snapshot --+
```

Keep the event stream as the audit trail, but stop using it as the only state model. Add explicit
`sessions`, `tasks`, and `leases` tables; generate events from their transitions. Humans and agents
read `status`, not raw `recent`. `recent` remains the forensic view.

## 1. Resolve the project before deriving scope

Use the nearest ancestor `.atlas` as the explicit coordination boundary, even when it contains
nested Git repositories. Fall back to the current nearest Git common dir when no `.atlas` exists.
Extend workspace metadata with a stable `id`, optional `members`, scope aliases, and a coordination
mode (`off`, `observe`, `warn`, `enforce`). Store the journal beside the boundary repo's Git common
dir; for a non-Git workspace, use an Atlas state directory keyed by the stable id.

Every event carries `project_id`, `repo_id`, `worktree_id`, `session_id`, and `task_id`. Paths are
realpath-normalized, checked against the project boundary, then stored project-relative. This fixes
the parent-workspace/nested-repo blind spot and makes identities independent of the current cwd.

## 2. Turn scopes into renewable leases

Start with exclusive write leases; reads do not need locking. Keep the existing vocabulary, but
give each scope type deterministic overlap rules:

- `path:a` conflicts with `path:a`, descendants of `a`, and ancestors of `a`.
- `artifact:x`, `service:x`, `host:x`, and `port:x` conflict by exact canonical key.
- Split Git into `git:index:<worktree>`, `git:ref:<full-ref>`, `git:remote:<remote/ref>`, and
  `git:worktree-admin`; a generic `git:*` lease is too broad to permit useful concurrency.
- A workspace alias such as `component:api` expands to configured primitive scopes before claim.

Acquire leases in one `BEGIN IMMEDIATE` transaction: delete expired leases, test every requested
scope for overlap, then insert all or none. Claims are re-entrant for the same session. Each claim
has a generation/fencing token, heartbeat, expiry, task, and short rationale. Hooks renew leases;
wrapped long-running commands renew until the child exits. SessionEnd releases immediately, while
expiry recovers from crashes. Forced takeover requires a reason and creates a durable audit event.

### Lockfiles

Do not add one lockfile per scope as a second source of truth. Atomic files are attractive, but
hierarchical path overlap requires scanning, stale ownership is ambiguous across hosts, and a DB
plus files creates reconciliation bugs. SQLite already supplies the transaction lock needed to
prevent double claims. If external tools need a sentinel, materialize a read-only JSON snapshot
from the leases table; never accept writes to it. Native Git lockfiles remain Git's concern.

No lease can stop a non-cooperating process or undo a shell command already running. Enforcement
is therefore a harness guardrail, strengthened by narrow command wrappers and worktree isolation,
not a distributed lock service.

## 3. Normalize harness hooks behind one command

Add `atlas agent-log hook`, reading hook JSON on stdin and emitting the harness-specific response; adapters normalize Claude Code and Codex payloads into the same internal events. Codex currently
supports the needed lifecycle events and command hooks; project hooks require explicit trust.

| Hook | Agent Log behavior |
| --- | --- |
| `SessionStart` | Register session, reap stale leases, inject a token-capped `status` snapshot |
| `UserPromptSubmit` | Open/continue a task with prompt hash and user-provided title; do not store raw prompts by default |
| `SubagentStart/Stop` | Record parentage; inherit the task but require an explicit or derived scope partition |
| `PreToolUse` | Derive paths from edit/patch tools; acquire or check leases; return conflict context or deny |
| `PostToolUse` | Renew leases and close automatically observed checks/operations with their result |
| `PreCompact/PostCompact` | Checkpoint and re-inject task, owned scopes, evidence, blockers, and next action |
| `Stop` | Once only, require a structured checkpoint if the session still owns leases; avoid stop loops |
| `SessionEnd` | Close session, release leases, and write a structured automatic handoff |

For Bash, parse only a small allowlist of known mutations: Git state changes, package installs,
migrations, deploys, and service/port operations. Never pretend arbitrary shell can be parsed
safely. In `warn` mode, unknown mutations produce context; in `enforce`, projects may require an
explicit `claim` or an Atlas wrapper. Pre-tool checks for `apply_patch`/Edit/Write can be strict
because their target paths are deterministic.

Git commits need special treatment in a shared worktree: block a commit when staged paths are not
owned by the session, and record `head_before`, `head_after`, and staged paths. In separate
worktrees, file leases can be looser, but refs, remotes, deploys, ports, and services remain shared.

## 4. Make the state useful, quiet, and self-correcting

Introduce these commands:

- `status [--json]`: task, peers, owned/conflicting leases, valid findings, checks, and next action.
- `claim <scope...> -- <why>`, `release [scope...]`, and `renew`: explicit escape hatches.
- `checkpoint --done ... --next ... [--blocked ...]`: structured handoff state, not 240 characters.
- `guard -- <command>`: lease-aware replacement for high-risk wrappers.
- `doctor`: hook coverage, schema version, stale sessions, unresolved aliases, and clock skew.
- `gc`: retention and safe cleanup; never required on the hot path.

Store semantic evidence as `{kind, locator, observed_at, fingerprint}` rather than a free-form
string. A test result can be invalidated when HEAD or its input fingerprint changes; a file finding
can expire when the file changes. Keep low-level tool telemetry in a separate, short-retention
table so `status` stays quiet. Add an idempotency key based on harness/session/hook/tool-use/phase
because hooks can retry. Version the schema with `PRAGMA user_version` and expose a DB view or
versioned JSON contract so the API does not duplicate `visibleRows` logic.

## Rollout

1. **State foundation:** project resolver, schema migration, sessions/tasks/leases, overlap tests,
   and `status`/`claim`/`release`/`doctor`. Preserve current commands as thin transitions.
2. **Observe:** install Claude and Codex adapters for session, subagent, compaction, and tool hooks;
   report would-be conflicts without blocking. Measure false positives and manual command rate.
3. **Enforce deterministic writes:** path edits, staged-file commits, refs, deploys, ports, and
   services. Keep opaque Bash warning-only unless a project opts into strict mode.
4. **Surface:** make `prime` use `status`, expose the same contract through atlas-api, and add a
   project dashboard for live tasks, conflicts, stale leases, and handoffs.

## Acceptance scenarios

- Two sessions editing disjoint files proceed; parent/child path claims conflict before the write.
- A crashed session's lease expires; a live long build retains its lease through heartbeats.
- A forced takeover fences the old session at its next tool call and records who/why.
- Nested workspace members resolve to one coordination boundary; independent projects do not.
- A commit containing another session's staged file is blocked with an actionable explanation.
- Resume and compaction restore the same task/lease snapshot without parsing transcript internals.
- Duplicate hook delivery creates one transition; a broken journal never prevents SessionEnd.

## Current harness references

- [OpenAI Codex hooks](https://learn.chatgpt.com/docs/hooks)
- [Claude Code hooks reference](https://code.claude.com/docs/en/hooks)
