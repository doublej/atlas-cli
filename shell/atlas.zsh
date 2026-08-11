# atlas-cli shell integration for zsh
# Add to your .zshrc: source /path/to/atlas.zsh
#
# A child process can't cd — or run anything — in the shell that spawned it. So commands
# that need the parent shell (`atlas jump`, `atlas new`, `atlas <query> --run …`) write a
# shell line to $ATLAS_SHELL_FILE and this wrapper evals it. Everything else is unaffected.
atlas() {
    local file rc
    file=$(mktemp -t atlas-shell) || return 1
    ATLAS_SHELL_FILE="$file" command atlas "$@"
    rc=$?

    if (( rc == 0 )) && [[ -s "$file" ]]; then
        eval "$(<"$file")"
        rc=$?
    fi
    rm -f "$file"
    return $rc
}

# `pj [query] [--run <cmd>]` — jump to a project; no query opens the fuzzy picker.
pj() {
    atlas jump "$@"
}
