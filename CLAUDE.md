# atlas-cli

The global **`atlas`** command: a thin Bun/TypeScript client to atlas-api (`:47891`, override with
`ATLAS_API`). Workspace architecture and vocabulary are in the parent `../CLAUDE.md`.

See `docs/commands.md` for the full command table, the `src/` layout and how the `shell/atlas.zsh`
wrapper works.

## Mental model

- **A consumer of the API, never a producer.** It never scans or reads the cache itself. The
  exceptions are local-only by design and have no API: `disk`, `board`, `flow`.
- **`requireUp()` self-heals**: it kickstarts `com.jurrejan.atlas-api` and polls before giving up.
  Commands that skip it degrade (print the URL or a hint) instead.
- **A child process can't change its parent shell.** Commands that must (`jump`, `new`) write one
  line to `$ATLAS_SHELL_FILE`, which `shell/atlas.zsh` evals (`util.ts:shellExec`/`cdLine`).

## Invariants

- **Every data command takes `--json`** (one compact document on stdout, the text-mode exit code).
  The text-only exceptions are listed in `prime.ts` `OUTPUT`; keep that list true. When a
  command's contract changes, update `prime.ts` `WORKFLOWS`/`GUARDRAILS` too.
- **Import `new-prompts.ts` lazily**: loading `@inquirer/prompts` at startup cuts every command's
  piped stdout at 64 KB.
- **`src/processes.ts` mirrors `atlas-api/src/lib/processes/types.ts`**; change both together.
- **`jump`/`search` rank local-first**: a Fractal/Ubuntu twin never outranks a project that exists
  here.
- **`kill` always dry-runs first** (`POST /api/processes/stop` with `dryRun: true`) and drops the
  CLI's own ancestry; no TTY and no `--yes` is exit 4. The server does every other safety check.
- **`disk`**: every change goes through `src/disk/oplog.ts` (start fsync'd first), `lock.ts` (one
  job at a time) and `approval.ts` (the policy table: edit it there, nowhere else). Spec:
  `../.orchestrate/disk-spec.md`. Test with `ATLAS_DISK_HOME=<scratch>` and fixture
  `devRoot`/`archiveDir`, never against real projects.
- **`board`** tests set `ATLAS_BOARD_PATH` and `ATLAS_BOARD_QUIET=1`. `speak`'s
  `claude -p --model haiku` rewrite needs `MAX_THINKING_TOKENS=0` or it takes a minute.

## Adding a command

1. Create `src/commands/<name>.ts` exporting `const <name>: Command` (one responsibility, lean on
   `api.ts`/`util.ts`).
2. Register it in `src/registry.ts` (`COMMANDS`). Help, `atlas prime`'s list and zsh completion
   come from `name` + `summary` (+ `usage`). Rerun `atlas install-autocompletion` afterwards.
3. Test it against `src/fake-api.ts`, never the live daemon.

## Verification

```bash
bun install && bun link   # install the `atlas` bin onto PATH (~/.bun/bin)
bunx tsc --noEmit         # typecheck
bun test
```

Conventions: Bun runtime, tabs, small functions (≤20 lines), files <150 lines.
