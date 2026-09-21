# CLAUDE.md

Guidance for Claude Code when working in `atlas-cli`.

## Overview

`atlas-cli` is the global **`atlas`** command — a thin Bun/TypeScript client to the
project-atlas API (`atlas-api` on `:47891`). It is the single source of truth for
cross-project atlas actions that used to be duplicated as per-project justfile recipes
(e.g. the `claude-tree` recipe across 15 cookiecutter templates now just calls `atlas tree web`).

It is a **consumer** of the API, not a producer — it never scans or reads the cache
directly (that's atlas-api's job). When the API is down, `requireUp()` self-heals by
kickstarting the `com.jurrejan.atlas-api` launchd daemon and polling before giving up;
commands that skip `requireUp()` degrade gracefully (print the URL / a hint) instead.

## Architecture

```
src/
  atlas.ts        entry — shebang + argv router (help / dispatch)
  registry.ts     COMMANDS table + usage() help text
  types.ts        Command interface { name, summary, run(args) }
  api.ts          API_BASE (ATLAS_API override), isUp(), apiGet/apiPost
  util.ts         die(), resolveRoot(), openUrl(), requireUp(), shellExec()/cdLine()
  tree-format.ts  pure terminal renderers for the CLAUDE.md tree (ascii/search/compose)
  logo.ts         atlas-picker's splash art, reused by `atlas help` (copy of splash.rs)
  template-discovery.ts  offline cookiecutter discovery + DEV_FOLDER/templatesDir (for `new`)
  new-prompts.ts  @inquirer/prompts helpers for `new` (category/template/output)
  commands/       one file per subcommand, each exporting a Command
shell/
  atlas.zsh       `atlas` zsh wrapper (+ the `pj` function) — evals what the CLI hands back
```

## Shell integration (`shell/atlas.zsh`)

A child process can't cd — or run anything — in the shell that spawned it. So commands that
need the parent shell write one shell line to `$ATLAS_SHELL_FILE`; the `atlas()` zsh function
creates that file, runs the real binary, then evals the line (`util.ts:shellExec`/`cdLine`).
Without the wrapper the line is printed instead, so it stays copy-pasteable. Users: `jump`
(cd, plus `--run`'s command chained after it) and `new` (cd into what it scaffolded).
Everything else passes straight through, exit code intact.

`pj` lives here too and is just `atlas jump "$@"` — the query/picker/`exec:` handling that
used to be duplicated in atlas-picker's `shell/pj.zsh` is now in the CLI. `pj.zsh` keeps
only the picker-specific `pjc`/`pjd`/widget helpers. Both files are sourced from `~/.zshrc`.

| Command | Status | Notes |
|---------|--------|-------|
| `prime [--json]` | ✅ | agent crash course, first in `atlas help`: purpose, command list (generated from `COMMANDS`), workflows, guardrails, output contract, detected cwd/project/API state. Markdown by default; `--json` emits the same model. Edit its `WORKFLOWS`/`GUARDRAILS` when a command's contract changes |
| `brief [--json\|--install-hook]` | ✅ | session briefing (last session, handoff, journal, beads, CLAUDE.md size) from local sources only; the global SessionStart hook. Silent outside a recognized project |
| `tree` | ✅ | no subcommand → prints tree help |
| `tree view [path] [--up]` | ✅ | ascii CLAUDE.md tree in the terminal (from `?root=` graph). `--up` requests `&up=1` — only the chain towards the root, skipping the walk into children |
| `tree search <q> [path]` | ✅ | case-insensitive search across every CLAUDE.md in the tree |
| `tree compose [path]` | ✅ | concatenate the ancestor→project chain — the loaded context, as one md doc (always `&up=1`; the chain *is* the up graph) |
| `tree web [path]` | ✅ | opens `/claude-tree?root=<path\|cwd>`; cookiecutter recipes call this |
| `info [path] [--json]` | ✅ | atlas's record for the current project (stack, port, dev hostname, branch/flow, scripts, deploy, domains, umami, beads, sessions). Resolves the nearest owning project from a subfolder; `--json` prints the raw `Project` |
| `init` | ✅ | writes a starter `.atlas` (replaces the old `atlas-init` zsh fn) |
| `new` | ✅ | scaffold a project: pick category (`/api/categories`) → template (`/api/templates`) → `cookiecutter`, then `POST /api/refresh`. Offline: local glob via `template-discovery.ts` + free-text category. Non-interactive: `atlas new <family/name> --name <n> --category <cat>\|--out <dir> [--var k=v ...]` (runs `cookiecutter --no-input`; agent-friendly). Ends inside the new project via the `shell/atlas.zsh` wrapper |
| `scan` | ✅ | `POST /api/refresh`, prints project/framework counts |
| `open` | ✅ | opens the atlas web UI |
| `run [path]` | ✅ | starts the project's dev server via `POST /api/run`, prints its hostname (falls back to `localhost:<port>` when Caddy dev hostnames aren't set up) |
| `pick` | ✅ | passthrough to `atlas-picker` (prints only — use `jump`/`pj` to cd) |
| `jump [q] [--run <cmd>]` | ✅ | the whole `pj` flow: best match, or the fuzzy picker with no query → hands the shell `cd <path> && echo → <name>`, with `--run`'s command chained on (`--cmd`/`-r` are aliases). `--run` is eval'd in the shell, so aliases and functions work; an unknown flag errors instead of being searched for. **Ranking is local-first** — a Fractal/Ubuntu twin can never outrank a project that exists here, which is what made `pj framelink` refuse — then exact name, then prefix, then a path hit, shallowest first. When no project carries the query as its name, a *folder* named exactly that wins (`pj framelink` → `multi-stack/framelink`, the workspace holding `app`/`auth`/`broker`); ambiguity there is broken by how many projects live under the folder |
| `search <q>` | ✅ | substring match on project name/path via `/api/projects`, same local-first ranking as `jump` (remote rows are tagged `[fractal]`); also the fallback for `atlas <query>` when the first arg isn't a command. With `--run` it delegates to `jump`, so `atlas <query> --run <cmd>` works |
| `install-autocompletion` | ✅ | generates `_atlas` (zsh, completes `atlas` **and** `pj`) into the first `$fpath` dir under `$HOME` — `~/.zsh/completions` when it's registered. Commands + summaries come from `COMMANDS`, so **rerun it after adding a command**; project names come from the scan cache via `jq` at completion time (no bun spawn per Tab). After `--run` it shifts the frame and calls `_normal`, so the command being run completes normally |
| `flow` | ✅ | branch flow. `flow`/`flow status` prints the current project's policy/trunk/integration from `/api/projects`; `flow audit` splits our repos into safe-to-migrate, blocked (dirty tree, wrong branch) and already-on-flow; `flow init [path] [--dry-run] [--force]` creates `develop`, renames `master` → `main`, writes the `.atlas` `flow` block. Pure local git — no API endpoint. `bootstrapFlow()` is exported for `atlas new` |
| `disk <sub>` | ✅ | disk-space manager, **local-only (no API)** — spec `../.orchestrate/disk-spec.md`. `analyze`/`archive`/`archives`/`restore` (idle projects ⇄ verified `.tar.zst` in iCloud), `scan`/`clean` (rebuildable folders by risk), `trim` (tools' own clean-up), `schedule` (launchd jobs in `launchd/`), `recover`, `log`, `config`, `doctor`, `tui` (→ `atlas-disk`). Code in `src/disk/`: every change goes through `oplog.ts` (start fsync'd first), `lock.ts` (one job at a time) and `approval.ts` (the spec's policy table — edit it there, nowhere else). Every subcommand returns a `Report`; `--json` and exit codes come from `report.ts`. Test with `ATLAS_DISK_HOME=<scratch>` and fixture `devRoot`/`archiveDir` — never against real projects |
| `ports` | ✅ | `GET /api/ports/audit` — prints port collisions (daemons + scanned projects) and unmanaged (port-bearing framework, no declared port) projects; exits 1 on collisions |

## Adding a command

1. Create `src/commands/<name>.ts` exporting `const <name>: Command` (keep it tiny —
   one responsibility, lean on `api.ts`/`util.ts` helpers).
2. Register it in `src/registry.ts` (`COMMANDS` array). Help text is generated from
   `name` + `summary`.

## Commands

```bash
bun install          # deps (bun-types, typescript)
bun link             # install the `atlas` bin onto PATH (~/.bun/bin)
bunx tsc --noEmit    # typecheck
atlas help           # list commands
```

Conventions: Bun runtime, tabs, small functions (≤20 lines), files <150 lines.
Override the API host with `ATLAS_API` (default `http://localhost:47891`).
