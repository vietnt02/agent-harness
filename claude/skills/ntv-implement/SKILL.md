---
name: ntv-implement
description: "How Claude does execution work itself: before Claude itself edits files in a repo, runs a data job, or changes a report or document. Minimal change, same-layer verification, manufacturing the state a check needs, waiting through watch.sh, push and PR. Not for coordinating Orca workers (ntv-orca)."
---

# /ntv-implement

## Who works

- Execution with a merge gate still ahead of production (a change to a repo or a document) goes
  to Orca workers (`CLAUDE.md` § Delegation). A change with no gate after it (a write to Lark, n8n
  or a DB, a real job run, a send, a hand publish such as Power BI) is Claude's: a worker only
  scouts, builds the command and runs it `--dry-run`; Claude reads that output, runs it for real
  and reads the result back. `hooks/dispatch-split-guard.cjs` blocks a worker spec or message
  holding a Lark or n8n write; it does not see SQL, curl or a job trigger. Claude does a gated change itself only: in `~/.claude`
  (rules, skills, hooks: only an agent on this harness judges them); the specs, plans and
  knowledge docs a coordinator writes (`plans/`, `knowledge/` in a repo); a change to an existing
  value or parameter with no new logic; work Viet names Claude for; a step needing a tool only
  this session holds (an MCP connector, a login).
- Before a production write, `git grep` the field or table across every repo that reads it: the
  ask names each reader (workflow, its schedule, the source it compares) with one consequence line;
  a reader comparing against a mirror that syncs later is paused, or both sides are written together.
- Before the first edit in a repo, the session note's `## Đang có hiệu lực` holds one line per
  repo: `Người làm: Claude — <repo folder> — "<Viet's sentence naming Claude>"` or `— <file>:
  <key> <old>→<new>`. `hooks/worker-default-guard.cjs` blocks Edit/Write into a git repo outside
  `~/.claude` (`.md` under `plans/`, `knowledge/` pass) until a line names that repo and its
  quote is in one of Viet's messages or it shows `→`; an Orca worker session is exempt.

## Change

- YAGNI, KISS: the minimum that does the task; no unasked features, single-use abstractions or
  handling for impossible cases; never a weaker design because it is cheaper today. 200 lines
  that could be 50 get rewritten.
- Touch only what the task needs: no "improving" adjacent code, comments or formatting; never
  split or restructure a file the task did not require. Unrelated dead code: mention it; remove
  only what your change made unused.
- Quality tracks the task: committed code and deliverables Viet acts on are production; scratch
  work and investigations optimise for insight and speed.
- A server or watcher you start: reuse or stop the one holding its port, never take another
  port. One started to check stops once checked, before the turn ends, and whatever it replaced
  runs again; kept only when Viet asked. Any other stops before its worktree or session ends.

## Verify (`CLAUDE.md` § Verification and claims holds the core)

- Turn the task into a check first: a bug → a test that fails before the fix; a refactor →
  tests pass before and after; a layout or document → render every page, including pages the
  change can spread to; Power BI → PBIR/TMDL only; a sweep ("rename every X to Y", "remove all
  Z") → a script scan of the result, done only at zero hits or a stated reason for each hit left;
  a migration (data, OS, folder to a new place) → a machine diff of the whole target against the
  source, metadata included (mode, owner, group: `rsync -aHAXn -i`), then a functional test as a
  non-root user, never a list of points you thought of.
- Before "done", name where Viet will see the change and look exactly there. A ratio names its
  denominator, exclusions and every miss by identifier.
- Reviewing code: report everything you find, no severity filter unless Viet asks. After fixing
  review findings, one last review round on the diff only, then stop. Orca review rounds follow the
  stop rule Viet set: the bullet **Tiêu chí dừng** in `ntv-orca/references/coordinator-rules.md`.
- Reviewing a bug fix: reproduce the bug first with a free read on the runtime the PR/MR blames (a
  log, a run's output, an env value read inside the container); the diagnosis is right only then,
  else report it as `chẩn đoán CHƯA kiểm`, whatever the fix's own tests say.
- A fix for a production bug whose root cause is known ships, in the same PR/MR, a machine check
  that fails if the cause returns (a build guard, a test on that path); a review comment asking for
  that check blocks the merge.
- The non-author review of your own change (`CLAUDE.md` § Delegation) goes, by default, to an
  Orca worker `agy gemini-argon high` reading the pushed PR/MR, spawned per `ntv-orca`; a Claude
  subagent only when Viet names one. A change to Claude Code itself (`~/.claude` rules, skills,
  hooks, scripts; a kaizen session) is reviewed by a Claude subagent: only an agent running this
  harness can judge a hook's contract or how a rule is read; never Codex or agy.

## Manufacture the condition, don't wait for it

- A check needing a state that has not arrived: create it on the test surface (a dev-DB
  timestamp, a `probe-*` row deleted in-turn), or run the deployed job by hand on its schedule
  config. Never wait on a scheduled run over 5 minutes away: trigger it, unless timing itself is
  under test.
- A test run of a local app still runs on Viet's machine: it never triggers (click or API call) an
  action that reaches the OS (`open`, Finder, a browser launch) unless the app stubs it on that run.
- Unmerged code runs only where the repo's docs allow (a local runner, a test deploy); never
  hand-copied to a server.
- A long or remote command runs in the background (`run_in_background`); several remote reads
  are one call (one query, one API list), never a CLI per item. A run you wait on goes through
  `~/.claude/scripts/watch.sh` (`--help`): `--once`, then the background loop; its CMD reads
  the run that produces the result, not only the target.
- Before "can't", name which rule forbids it and who could do it instead, and ask that person
  in the same turn.

## Ship

Push the branch, open the PR and report its link (tier A). Before merging a PR that deploys, read
the whole diff from your last read to the SHA being merged and run the repo's checks on that SHA.
Once its deploy is green, read what now runs on production (the deployed code, workflow or config)
before reporting done. A branch that already had a PR:
`CLAUDE.md` § Irreversible actions.
