#!/bin/bash
# worker-stall.sh - one line for one Orca worker, in the "<state> [context]" form watch.sh judges:
#   done <state>            the worker's Task ended (succeeded, failed, cancelled, ...)
#   running <why>           a file in its worktree changed within --idle-min minutes, no API error streak
#   stale <why>             nothing in its worktree changed for --idle-min minutes, or the tail of its
#                           transcript holds >= --api-errors 502/503/429-type errors
# It reads worker-show, the worktree's file times and worker-read; it never reads `orca orchestration
# check`, so it takes no message from the coordinator's inbox.
# A worker that is only reading for a long time also shows `stale`: that is a cue to look
# (worker-read twice, a few minutes apart), never to stop or rerun it (ntv-orca § 3).
#
#   worker-stall.sh --dispatch <ctx_id> [--idle-min 10] [--api-errors 3]
#
# Watching one worker from the coordinator (wakes it when the worker ends or stalls):
#   W="bash ~/.claude/scripts/worker-stall.sh --dispatch <ctx_id>"
#   ~/.claude/scripts/watch.sh --once --check "$W" --ok done --wait running
#   ~/.claude/scripts/watch.sh --check "$W" --ok done --wait running --deadline 4h --every 120   (background)
set -u
dispatch='' idle=10 errors=3
while [ $# -gt 0 ]; do
  case "$1" in
    --dispatch) dispatch="${2:-}"; shift 2 ;;
    --idle-min) idle="${2:-10}"; shift 2 ;;
    --api-errors) errors="${2:-3}"; shift 2 ;;
    -h|--help) sed -n '2,17p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[ -n "$dispatch" ] || { echo "--dispatch <ctx_id> is required" >&2; exit 2; }

show=$(orca orchestration worker-show --dispatch "$dispatch" --json 2>/dev/null) || { echo "worker-show failed for $dispatch" >&2; exit 1; }
read -r state workspace < <(printf '%s' "$show" | node -e '
  let s = ""; process.stdin.on("data", (c) => (s += c)).on("end", () => {
    const d = JSON.parse(s); const r = d.result || d;
    process.stdout.write(`${r.state || "unknown"} ${String(r.workspace || "").split("::").pop()}\n`);
  });')
case "$state" in
  succeeded|failed|cancelled|canceled|abandoned|released|completed) echo "done $state"; exit 0 ;;
esac

# The tail of the transcript: an API error streak means the worker spins without progress.
n=$(orca orchestration worker-read --dispatch "$dispatch" --source transcript --limit 200 2>/dev/null \
  | grep -cE 'HTTP[ /0-9.]*(502|503|429)|(502|503|429)[ :-]*(Bad Gateway|Service Unavailable|Too Many Requests)|RESOURCE_EXHAUSTED|UNAVAILABLE|Bad Gateway|Service Unavailable|Too Many Requests')
if [ "${n:-0}" -ge "$errors" ]; then echo "stale api-errors=$n state=$state"; exit 0; fi

if [ -d "$workspace" ]; then
  recent=$(find "$workspace" -name .git -prune -o -name node_modules -prune -o -type f -mmin "-$idle" -print 2>/dev/null | head -1)
  if [ -n "$recent" ]; then echo "running changed=${recent#"$workspace"/} state=$state"; exit 0; fi
  echo "stale idle>${idle}m state=$state"
  exit 0
fi
echo "running no-worktree state=$state"
