# atlas-cli

The global **`atlas`** command — a thin client to the [project-atlas](../) API
(`atlas-api` on `:47891`). One place for cross-project atlas actions, instead of
per-project justfile recipes.

## Install

```bash
bun install
bun link          # symlinks `atlas` into ~/.bun/bin (on PATH)
```

## Usage

```bash
atlas tree                   # print tree help (view / search / compose / web)
atlas tree view [path]       # print the CLAUDE.md tree as ascii in the terminal
atlas tree search <q> [path] # search every CLAUDE.md in the tree (case-insensitive)
atlas tree compose [path]    # concatenate the ancestor→project chain (the loaded context)
atlas tree web [path]        # open the folder's CLAUDE.md tree in the atlas web viewer
atlas init          # create a starter .atlas metadata file here
atlas scan          # force a rescan of the development catalog
atlas open          # open the atlas web UI
atlas pick          # fuzzy-pick a project (use the `pj` shell fn to cd on select)
atlas run           # start/stop a dev server (planned)
atlas help          # list commands
```

Set `ATLAS_API` to point at a non-default host (default `http://localhost:47891`).
When the API is down, commands print the URL / a hint instead of failing.
