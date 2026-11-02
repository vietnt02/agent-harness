#!/bin/bash
# watch.sh - wait on external state (CI pipeline, DAG run, VPS deploy) from a background
# Bash call; exits the moment the state is anything but a listed wait state, so the
# harness wakes Claude instead of a loop waiting silently on a value it never expected.
#
#   watch.sh --once --check CMD --ok LIST --wait LIST [--stderr-ok]          (foreground, first)
#   watch.sh --check CMD --ok LIST --wait LIST --deadline DUR [--every SECS] [--stderr-ok]
#            [--why-wait WHY] [--checkpoint SECS]
#
# CMD prints one line per item: "<state> [context...]". Only the first word is judged.
#   every line in --ok             -> DONE, exit 0
#   every line in --ok or --wait   -> keep waiting
#   any other state, empty output  -> UNEXPECTED, exit 3; the loop exits only when the next
#     check shows one too, so a transient state it saw once (GitLab's `locked`) passes
#   CMD exits non-zero, writes stderr (unless --stderr-ok), or runs past 60s -> error;
#     --once exits 2 on the first, the loop on the 3rd in a row
#   CMD's error says GitLab rate limit (HTTP 429) -> the loop backs off (every doubled, up to
#     300s) instead of counting an error; a CMD calling glab or gitlab.com polls at most every 30s
#   --deadline passes              -> TIMEOUT, exit 4
#   --checkpoint passes (10m)      -> CHECKPOINT, exit 6: tell the user the state, then rerun the
#     same loop (no new --once needed). A time you promised the user is the --deadline.
#     --checkpoint is at most 3000 (50m): each wake-up must land within Claude's 1-hour prompt
#     cache, or it reloads the whole context; a long --deadline is fine, it is checkpointed.
# The loop refuses to start (exit 5) unless --once ran the same CMD/--ok/--wait within 10 min:
#   the loop is the --once line minus --once plus --deadline (and --why-wait); retype nothing else.
# LIST is comma-separated: --ok success --wait running,pending,created
# --wait lists every non-terminal state of the system's state machine, not the ones you expect:
#   GitLab MR        --ok merged  --wait opened,locked
#   GitLab pipeline  --ok success --wait created,waiting_for_resource,preparing,pending,running,scheduled
#   Airflow run      --ok success --wait queued,running,none
# DUR is 90s, 30m, 2h or 2h30m.
# A loop --deadline over 5m needs --why-wait: why running the job by hand now cannot replace
# this wait (CI has no hand run; the timing itself is under test). It heads every result,
# and the report quotes it to the user.
# --deadline = when the awaited state is due + a small margin, read from the target's own past
# runs (last MR sync, last DAG run, last pipeline) or its schedule, never a round default; the
# --why-wait names that source. Past it, the state is overdue: report it, never wait longer.
# CMD measures what the user sees (the PR exists, the URL the live page references), never a
# proxy (a line a worker should print, a path you built yourself); when --once says wait,
# confirm that state once by another route. Two proxies that never match:
#   commit hashes: `%H` on both sides (or cut both to one length), never 8 chars vs `%h`'s 7;
#   a background command's output file: grep a content line, never the last line (the harness
#   appends `[exited ...]`);
#   a CI-created MR (core sync): list MRs (`state=all&order_by=created_at`) and filter in CMD for
#   the `source_branch` ending in the source `-<pipeline_id>` (`search` matches titles only);
#   never the branches API (merging deletes the branch, so the merged MR reads as `none`, a wait
#   state), never `created_at` against a time you picked (the MR may predate it).
# Before waiting, read the target's state right after the write in the same command (MR
# `state` after `glab mr merge`); no match -> stop and report, nothing downstream will come.
# CMD for a run you triggered prints that run's state too: once the run has ended and the awaited
# state has not arrived, print a state outside --ok/--wait so the loop exits at once.
# Wait only while the outcome can still change: a run whose log already shows a permission,
# config or repeat error is ended (mark failed) and reported, not waited through its retries.
# CMD never prints a --ok/--wait state from an error branch: a failed read or parse exits
# non-zero or prints "error <why>"; otherwise a broken measurement reads as a wait state.
# State only a file shows (a stdio MCP runner appending replies to out.log), with a short
# --deadline; past it the wait is stuck, not "still waiting on the user":
#   --check 'grep -q "### END" out.log && echo done || echo waiting' --ok done --wait waiting
#
# watch.sh or hooks/watch-guard.cjs misbehaves (a bug, a false wake, a missed state, a pattern that
# slips through) or a wait it cannot express: tell the user in one line; they record it with
# /ntv-kaizen. History lines carry each check's duration; a check slower than half of --every
# is flagged, since the wait then sees state late.

CHECK_TIMEOUT=60
MAX_ERRORS=3
ONCE_TTL=600
MARK_DIR="${TMPDIR:-/tmp}/claude-watch"

usage() { sed -n '2,/^$/p' "$0" | sed 's/^# \{0,1\}//'; exit 5; }
die() { echo "WATCH REFUSED: $*"; exit 5; }

once=0 stderr_ok=0 every=20 check= ok= wait= deadline= why= checkpoint=600
while [ $# -gt 0 ]; do
  case "$1" in
    --once) once=1 ;;
    --why-wait) why=$2; shift ;;
    --stderr-ok) stderr_ok=1 ;;
    --check) check=$2; shift ;;
    --ok) ok=$2; shift ;;
    --wait) wait=$2; shift ;;
    --every) every=$2; shift ;;
    --deadline) deadline=$2; shift ;;
    --checkpoint) checkpoint=$2; shift ;;
    -h|--help) usage ;;
    *) die "unknown argument: $1" ;;
  esac
  shift
done

[ -n "$check" ] && [ -n "$ok" ] && [ -n "$wait" ] || die "--check, --ok and --wait are required"
case "$every" in ''|*[!0-9]*|0) die "--every must be a positive number of seconds" ;; esac
# GitLab.com counts every request of one account in a 100-a-minute window the whole team shares.
if [[ $check == *glab* || $check == *gitlab.com* ]] && [ "$every" -lt 30 ]; then every=30; fi
case "$checkpoint" in ''|*[!0-9]*|0) die "--checkpoint must be a positive number of seconds" ;; esac
[ "$checkpoint" -le 3000 ] || die "--checkpoint must be at most 3000 s: a wake-up past Claude's 1-hour prompt cache reloads the whole context"
if [ $once -eq 0 ] || [ -n "$deadline" ]; then
  [[ $deadline =~ ^([0-9]+h)?([0-9]+m)?([0-9]+s)?$ ]] && [ -n "$deadline" ] \
    || die "--deadline must look like 90s, 30m, 2h or 2h30m (got '$deadline')"
  h=${BASH_REMATCH[1]%h} m=${BASH_REMATCH[2]%m} s=${BASH_REMATCH[3]%s}
  limit=$(( 10#${h:-0} * 3600 + 10#${m:-0} * 60 + 10#${s:-0} ))
  [ $limit -gt 0 ] || die "--deadline must be longer than 0s"
  [ $once -eq 1 ] || [ $limit -le 300 ] || [[ $why =~ [^[:space:]] ]] \
    || die "--deadline over 5m needs --why-wait: a run more than 5 min away is triggered by hand, not waited on"
fi

key=$(printf '%s\n' "$check" "$ok" "$wait" "$stderr_ok" | shasum | cut -c1-16)
mark="$MARK_DIR/$key"
out=$(mktemp) err=$(mktemp)
pid=
trap '[ -n "$pid" ] && kill -TERM -- -$pid 2>/dev/null; rm -f "$out" "$err"' EXIT

in_list() { case ",$2," in *",$1,"*) return 0 ;; esac; return 1; }

# One check. Sets verdict (done|wait|unexpected|error) and detail.
evaluate() {
  set -m  # own process group, so a hung pipeline can be killed as a whole
  bash -o pipefail -c "$check" >"$out" 2>"$err" &
  pid=$!
  set +m
  local ticks=0 rc
  while kill -0 $pid 2>/dev/null; do
    if [ $ticks -ge $(( CHECK_TIMEOUT * 5 )) ]; then
      kill -TERM -- -$pid 2>/dev/null
      wait $pid 2>/dev/null; pid=
      verdict=error detail="check still running after ${CHECK_TIMEOUT}s"
      return
    fi
    sleep 0.2; ticks=$(( ticks + 1 ))
  done
  wait $pid; rc=$?; pid=
  if [ $rc -ne 0 ]; then
    verdict=error detail="check exited $rc: $(head -c 400 "$err" | tr '\n' ' ')"; return
  fi
  if [ $stderr_ok -eq 0 ] && [ -s "$err" ]; then
    verdict=error detail="check wrote stderr: $(head -c 400 "$err" | tr '\n' ' ')"; return
  fi
  if ! grep -q '[^[:space:]]' "$out"; then
    verdict=unexpected detail="empty output"; return
  fi
  local line state all_ok=1
  while IFS= read -r line || [ -n "$line" ]; do
    state=$(printf '%s\n' "$line" | awk '{print $1}')
    [ -z "$state" ] && continue
    if in_list "$state" "$ok"; then :
    elif in_list "$state" "$wait"; then all_ok=0
    else verdict=unexpected detail="$line"; return
    fi
  done <"$out"
  [ $all_ok -eq 1 ] && verdict=done || verdict=wait
  detail=$(awk 'NF{print $1}' "$out" | sort | uniq -c | awk '{printf "%s%s×%s", (NR>1?" ":""), $2, $1}')
  [ "$(grep -c '[^[:space:]]' "$out")" -eq 1 ] && detail=$(grep -m1 '[^[:space:]]' "$out")
}

start=$(date +%s)
history=
last=
elapsed() { echo "$(( $(date +%s) - start ))s"; }
finish() {  # code label detail
  [ -n "$why" ] && echo "why wait: $why"
  [ -n "$history" ] && printf 'history:\n%s' "$history"
  if [ -s "$out" ]; then echo "last output:"; head -40 "$out"; fi
  echo "WATCH $2 after $(elapsed): $3"
  exit "$1"
}

if [ $once -eq 1 ]; then
  evaluate
  case $verdict in
    done|wait) mkdir -p "$MARK_DIR" && touch "$mark" ;;
  esac
  case $verdict in
    done) finish 0 DONE "$detail" ;;
    wait) echo "ONCE OK (would keep waiting): $detail"; head -40 "$out"
      echo "Before the loop: confirm this wait state once by another route (the source pipeline, the page itself)."
      exit 0 ;;
    unexpected) finish 3 UNEXPECTED "$detail" ;;
    error) finish 2 ERROR "$detail" ;;
  esac
fi

[ -f "$mark" ] && [ $(( $(date +%s) - $(stat -f %m "$mark") )) -le $ONCE_TTL ] \
  || die "run the same command with --once in the foreground first (within $(( ONCE_TTL / 60 )) min)"

errors=0 strange=0 slow_flagged=0 backoff=0
while :; do
  t0=$(date +%s)
  evaluate
  dur=$(( $(date +%s) - t0 ))
  if [ $slow_flagged -eq 0 ] && [ $(( dur * 2 )) -gt "$every" ]; then
    history="$history$(date +%H:%M:%S) SLOW: one check took ${dur}s, over half of --every ${every}s"$'\n'; slow_flagged=1
  fi
  if [[ $verdict = error || ( $verdict = unexpected && $detail == error* ) ]] \
    && [[ $detail =~ (HTTP\ 429|429\ Too\ Many|[Rr]ate\ limit\ exceeded) ]]; then
    backoff=$(( backoff ? backoff * 2 : every )); [ $backoff -gt 300 ] && backoff=300
    history="$history$(date +%H:%M:%S) GitLab rate limit, next check in ${backoff}s"$'\n'
    [ $(( $(date +%s) - start + backoff )) -gt "$limit" ] && finish 4 TIMEOUT "deadline $deadline passed, still rate limited"
    sleep "$backoff"
    continue
  fi
  backoff=0
  if [ "$verdict" = error ]; then
    errors=$(( errors + 1 ))
    history="$history$(date +%H:%M:%S) error: $detail"$'\n'
    [ $errors -ge $MAX_ERRORS ] && finish 2 ERROR "$MAX_ERRORS errors in a row, last: $detail"
  else
    errors=0
    if [ "$detail" != "$last" ]; then
      history="$history$(date +%H:%M:%S) $detail (check ${dur}s)"$'\n'; last=$detail
    fi
    [ "$verdict" = done ] && finish 0 DONE "$detail"
    if [ "$verdict" = unexpected ]; then
      strange=$(( strange + 1 ))
      [ $strange -ge 2 ] && finish 3 UNEXPECTED "$detail (2 checks in a row)"
    else
      strange=0
    fi
  fi
  [ $(( $(date +%s) - start + every )) -gt "$limit" ] && finish 4 TIMEOUT "deadline $deadline passed, still: $detail"
  if [ $(( $(date +%s) - start + every )) -gt "$checkpoint" ]; then
    touch "$mark"
    finish 6 CHECKPOINT "${checkpoint}s passed, still: $detail. Tell the user, then rerun the same loop"
  fi
  sleep "$every"
done
