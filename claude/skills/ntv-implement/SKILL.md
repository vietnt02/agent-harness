---
name: ntv-implement
description: "Viet's own notes for when Claude does the work itself: before Claude edits files in a repo, runs a data job, or changes a report or document. Only what Claude cannot know alone: Viet's decisions, the limits of this machine and these systems, lessons already paid for. Who builds and who reviews: CLAUDE.md § Delegation and ntv-orca."
---

# /ntv-implement

The craft (a minimal change, no unasked features, a test before the fix) is Claude's own; these are
the notes it cannot know alone.

## Production writes

- A write with no gate after it (Lark, n8n or a DB, a real job run, a send, a hand publish such as
  Power BI) is Claude's to run (`ntv-orca` § 1). Before it, `git grep` the field or table across
  every repo that reads it: the ask names each reader (workflow, its schedule, the source it
  compares) with one consequence line; a reader comparing against a mirror that syncs later is
  paused, or both sides are written together.

## This machine

- A server or watcher you start: reuse or stop the one holding its port, never take another
  port. One started to check stops once checked, before the turn ends, and whatever it replaced
  runs again; kept only when Viet asked. Any other stops before its worktree or session ends.
- A test run of a local app still runs on Viet's machine: it never triggers (click or API call) an
  action that reaches the OS (`open`, Finder, a browser launch) unless the app stubs it on that run.
- A heavy command (a build, a full test suite, a typecheck, a dependency install) goes through
  `node ~/.claude/scripts/heavy.cjs -- <command>`, in the background since it may wait for a slot longer
  than a foreground call lives, so it takes turns with the workers' (`ntv-orca` § 2).
- Unmerged code runs only where the repo's docs allow (a local runner, a test deploy); never
  hand-copied to a server.

## Verify (`CLAUDE.md` § Verification and claims holds the core)

- Writing, changing or deleting tests, reviewing a diff's tests, or finishing a change that alters
  logic or touches an external system, real data, a schedule or permissions: `ntv-test` first.
- A layout or document → render every page, including pages the change can spread to; Power BI →
  PBIR/TMDL only; a sweep ("rename every X to Y", "remove all Z") → a script scan of the result, done
  only at zero hits or a stated reason for each hit left; a migration (data, OS, folder to a new
  place) → a machine diff of the whole target against the source, metadata included (mode, owner,
  group: `rsync -aHAXn -i`), then a functional test as a non-root user, never a list of points you
  thought of.
- Before "done", name where Viet will see the change and look exactly there. A ratio names its
  denominator, exclusions and every miss by identifier.
- Someone's bug fix: reproduce the bug first with a free read on the runtime the PR/MR blames (a log,
  a run's output, whether a setting is set there, never a secret's value); the diagnosis is right
  only then, else report it as `chẩn đoán CHƯA kiểm`, whatever the fix's own tests say.
- A production bug fix whose root cause is proven ships, in the same PR/MR, a machine check that
  fails if that cause returns (a build guard, a test on that path); without it, it does not merge. A
  root cause not yet proven is reported `CHƯA kiểm`, and the change never merges described as the fix.

## Waiting

- A check needing a state that has not arrived: create it on the test surface (a dev-DB
  timestamp, a `probe-*` row deleted in-turn), or run the job by hand on a copy of its schedule
  config and of every state it reads (`ntv-test` § 2). Never wait on a scheduled run over 5 minutes
  away: trigger it, unless timing itself is under test.
- A run you wait on goes through `~/.claude/scripts/watch.sh` (`--help`): `--once`, then the
  background loop; its CMD reads the run that produces the result, not only the target.
- Before "can't", name which rule forbids it and who could do it instead, and ask that person in the
  same turn.

## Ship

- Once a deploy is green, read what now runs on production (the deployed code, workflow or config)
  and open both the changed page and one outside the change that shares its platform (a report beside
  the new one) before reporting done. Either page still off from what it should show once the deploy
  reports green, a "loading"/"updating" state included → take the faster way back to right: cause not
  yet proven on that runtime's logs, or the fix ships slower than a revert → revert first and debug on
  the reverted state; cause proven and the fix ships as fast (a revert that goes through the same
  pipeline is no faster) → fix forward, checked as § Verify asks. Never wait one out on a revertible
  deploy.
