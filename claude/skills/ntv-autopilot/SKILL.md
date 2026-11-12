---
name: ntv-autopilot
description: Lock what the user and Claude agreed into a plan, clear every open question, then ask the final gate; a yes switches the session from manual to Claude running the whole plan alone, tier C included, whether or not the user is at the machine. Invoked only when the user types /ntv-autopilot.
disable-model-invocation: true
---

# /ntv-autopilot

The plan file is the proof of what was agreed. `CLAUDE.md` § Mutation gate, Standing
permission opens every action it lists while its front matter says `status: approved`.
Once approved, nobody may be there to answer: every question asked later costs the user's
whole absence. Not this: the machine goes off → `/ntv-shutdown`.

## Write the plan (this turn)

1. Path: `~/.claude/plans/<cwd-slug>/<yymmdd>-<topic>.md`, `<cwd-slug>` as for session notes.
2. Front matter: `status: draft`, `session: <id>`, `cwd: <path>`.
3. Body, only what the conversation agreed (no new scope); work already under way in the open
   block goes in too:
   - **Goal**: one or two lines.
   - **Actions**: one line each: what, its target (repo, branch, table, host), its tier per
     `CLAUDE.md` § Irreversible actions. Name each tier C step in full ("merge `x` into
     `main` → deploys the VPS, whose 08:00 job emails customers").
   - **Files and repos** it touches.
   - **Done when**: the check for each action, at the layer of its claim
     (`CLAUDE.md` § Verification and claims).
   - **Prerequisites**: everything a listed action needs that the run cannot obtain alone (a
     login, a token, a permission, a secret's presence, quota or credit, a free port, a file at
     an agreed path), each with its read-only check and today's result. One not ready is an open
     question naming what makes it ready (where the user puts it, what frees it, when it resets);
     a secret is never pasted into the conversation.
   - **Defaults**: each reversible technical choice Claude made that the plan relies on, one line
     with its reason; the user may override any at the gate. An irreversible or user-visible
     choice (a name others will read, a send time) is an open question, not a default.
   - **Out of scope**.
   - **Open questions**.
   Every action carries `chốt làm` or `chốt hoãn`; anything else, including a content review
   promised for later (an outline, a draft), is an open question.
4. Check or render everything the block has produced so far, and run every prerequisite check.
5. End the turn that writes or changes the plan with a message: the plan's full path and a
   summary (the design settled, actions by group, each tier C step by name, Done when,
   prerequisites with their results, defaults, out of scope). From the next turn, ask in one
   AskUserQuestion call: every open question, the role question if the user named none
   (`CLAUDE.md` § Scope). Recommended option first. Only
   when none is left, ask the final gate in one AskUserQuestion: run this plan on autopilot?
   Never ask it while a question is open.

## Approve

On a yes to the final gate (or "chốt plan"), with no question left open: set `status: approved`
and add `approved: "<the user's exact reply>" <yyyy-mm-dd HH:MM> UTC+7`. The approval holds for
this session only. Any change to the plan's scope afterwards: back to `status: draft`, and ask
again.

## Run

- First, rerun every prerequisite check: one failing parks the actions that need it, and every
  action that needs a parked action's result.
- Every listed action runs without a new ask, tier C included, after the checks
  `CLAUDE.md` § Irreversible actions puts before a tier-C step.
- Never stop the plan to ask. A question the plan or the user's words already answer is no
  question; reads, probes and checks never need a yes. Whatever surfaces runs the three checks
  (`CLAUDE.md` § Mutation gate): all yes → fix, check, one-line report; otherwise park it and
  continue with the rest. A run the plan depends on: wait in the background with
  `~/.claude/scripts/watch.sh`, never on the user.
- An action the plan does not list, or one needing intent the plan does not state: park it.
- The user interrupts: stop; every tier-C step is asked again.
- A classifier or permission denial: never retry it in another form; park that step with its
  exact command (`rules/mine/user-profile.md`).

## Report

One report: `**Claude đã làm:**` with what was checked, and what was not, per action, then `**Quyết định thay
bạn:**`, each technical choice inside a listed action that the plan did not state and that
changes nothing the user feels, one line with its reason (a choice needing intent was parked,
never listed here), then `**Đã park:**`, each item with why and the exact command or decision
it needs. Every listed action done → `status: done`.
