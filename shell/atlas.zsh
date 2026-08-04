# atlas-cli shell integration for zsh
# Add to your .zshrc: source /path/to/atlas.zsh
#
# A child process can't cd its parent shell, so `atlas new` writes the created project
# path to $ATLAS_CD_FILE and this wrapper cds there. Every other subcommand passes
# straight through to the real binary.
atlas() {
    if [[ "$1" != "new" ]]; then
        command atlas "$@"
        return
    fi

    local cdfile dest rc
    cdfile=$(mktemp -t atlas-cd) || return 1
    ATLAS_CD_FILE="$cdfile" command atlas "$@"
    rc=$?
    [[ -s "$cdfile" ]] && dest=$(<"$cdfile")
    rm -f "$cdfile"

    if (( rc == 0 )) && [[ -n "$dest" && -d "$dest" ]]; then
        cd "$dest" || return 1
        echo "→ $(basename "$dest")"
    fi
    return $rc
}
