---
name: ntv-autopilot
description: Lock what the user and Claude agreed into a plan, clear every open question, then ask the final gate; a yes switches the session from manual to Claude running the whole plan alone, tier C included, whether or not the user is at the machine. Load before the first change of any block that changes a repo, data, config or automation (`CLAUDE.md` § Mutation gate), or when the user types /ntv-autopilot; never for a question or read-only work.
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
   - **Test strategy**: one line per behaviour or risk: what is checked, where (an isolated copy
     of every state the live system reads, never the live one: `ntv-test` § 2), and what counts as
     done at its layer; what cannot be checked is named here, before the run.
   - **Prerequisites**: everything a listed action needs that the run cannot obtain alone (a
     login, a token, a permission, a secret's presence, quota or credit, a free port, a file at
     an agreed path), each with its read-only check and today's result. One not ready is an open
     question naming what makes it ready (where the user puts it, what frees it, when it resets);
     a secret is never pasted into the conversation.
   - **Manifest**, when the plan hands work to Orca workers: load `ntv-orca` before writing it;
     each worker's agent, model, effort and worktree follow its § 2, never a Defaults line.
   - **Defaults**: each reversible technical choice Claude made that the plan relies on, one line
     with its reason; the user may override any at the gate. An irreversible or user-visible
     choice (a name others will read, a send time) is an open question, not a default.
   - **Out of scope**.
   - **Open questions**.
   Every action carries `chốt làm` or `chốt hoãn`; anything else, including a content review
   promised for later (an outline, a draft), is an open question.
4. Check or render everything the block has produced so far, and run every prerequisite check.
5. In the turn that writes or changes the plan, ask at once (unless the user's last reply was a
   question: that turn only answers it, and the ask waits for the next reply), in one
   AskUserQuestion call, every open question, recommended option first; each names the plan's full path and what it decides,
   since the box hides the text above it. Write each answer into the plan (its action's `chốt làm`
   or `chốt hoãn`, Open questions emptied, a prerequisite it changes checked again). Once none is
   left, in that same turn, ask the final gate in one AskUserQuestion: run this plan on autopilot?
   Its question names the plan's path, the actions by group, each tier C step by name, the
   prerequisites with their results, the defaults and out of scope. Never ask it while a question
   is open. A plan written on a yes to `ntv-architect`'s final gate is approved then: no second gate.
   Unless a yes starts the run (its Report ends the turn), end the turn with the plan's full path
   and a summary (the design settled, actions by group, each tier C step by name, Done when,
   prerequisites with their results, defaults, out of scope).

## Approve

On a yes to the final gate (or "chốt plan"), with no question left open: set `status: approved`
and add `approved: "<the user's exact reply>" <yyyy-mm-dd HH:MM> UTC+7`. The approval holds for
this session only. Any change to the plan's scope afterwards: back to `status: draft`, and ask
again; the one exception is an action the user approves by name in the Report's ask (below).

## Run

- First, rerun every prerequisite check: one failing parks the actions that need it, and every
  action that needs a parked action's result.
- Every listed action runs without a new ask, tier C included, after the checks
  `CLAUDE.md` § Irreversible actions puts before a tier-C step.
- Never stop the plan to ask. A question the plan or the user's words already answer is no
  question; reads, probes and checks never need a yes. Whatever surfaces: a fix that makes a
  listed action's output do what the plan approved (`CLAUDE.md` § Mutation gate, Fixes need no
  ask) → fix, check, one-line report; anything else → park it and continue with the rest. A run the plan depends on: wait in the background with
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

Anything parked or surfaced: in the same turn, before the report, one AskUserQuestion
(recommended option first) holds every `Đã park` item and each new point, each question standing
alone (the box hides the text above it); the report, the turn's last text, then says what the
answers changed. An answer approving a named action adds it to the plan, approved, and the next
run starts with no new gate; any other change sends the plan back to `status: draft` and its gate.
Nothing parked or surfaced: no ask, the plan stays `done`. Never ask mid-run.
