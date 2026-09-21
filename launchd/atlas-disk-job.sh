#!/bin/bash
# atlas-disk-job.sh <job> <atlas disk args…> — what the atlas-disk launchd jobs run.
# launchd has no login shell: set PATH, log the run to ~/Library/Logs/atlas-disk/<job>-<stamp>.log,
# record the last result for `atlas disk schedule status` / `doctor`, keep 30 days of logs.
set -u
job="$1"
shift
export PATH="$HOME/.cargo/bin:$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
here="$(cd "$(dirname "$0")" && pwd -P)"
logs="$HOME/Library/Logs/atlas-disk"
state="${ATLAS_DISK_HOME:-$HOME/Library/Application Support/atlas-disk}"
mkdir -p "$logs" "$state"
log="$logs/$job-$(date +%Y%m%d-%H%M%S).log"
started="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

bun "$here/../src/atlas.ts" disk "$@" >"$log" 2>&1
code=$?

printf '{"exit":%d,"startedAt":"%s","finishedAt":"%s","log":"%s"}\n' \
	"$code" "$started" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$log" >"$state/schedule-$job.json.tmp" &&
	mv "$state/schedule-$job.json.tmp" "$state/schedule-$job.json"
find "$logs" -name "$job-*.log" -mtime +30 -delete 2>/dev/null
exit "$code"
