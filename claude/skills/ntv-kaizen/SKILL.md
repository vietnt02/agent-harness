---
name: ntv-kaizen
description: "Record this session's mistakes as files on the Desktop for Viet's next kaizen session, once at session end: when the session note turns `status: done` (the session-notes hook says so), or when Viet asks for it. During the work no file is written: a mistake is fixed in the task's output and named in the report. Also load it before the first edit when Viet types /ntv-kaizen or asks to read, check or discuss the kaizen files on the Desktop (`kaizen-*.md`, \"check kaizen ở desktop\"): that is a kaizen session, which applies each file and then deletes it."
---

# /ntv-kaizen

## Record a mistake

1. During the work no kaizen file is written, and none is offered: a file never settles a
   mistake. Fix the task's output first in this turn (redo the check, correct the answer), name the
   mistake in the report at full severity with no mitigating fact, and return to Viet's topic.
2. At session end (the note turned `status: done`, or Viet asks), read the session transcript
   (`.jsonl`), never memory, and list each of these:
   - a sentence of `~/.claude/CLAUDE.md`, `~/.claude/rules/mine/*.md` or a file they point to that
     Claude broke, caught by Viet or by Claude itself (a secret printed, a wrong dispatch, a claim
     later found wrong), even when undone before Viet saw it;
   - a matter Viet corrected twice, or a mistake with a real consequence (a tier B/C action done
     wrong, Viet had to interrupt, block or undo);
   - a defect of the harness itself (hook, rule, skill), Claude's mistake or not
     (`## Rule đã phạm`: "lỗi của harness").
   Anything else is no file. Nor is a break of Claude Code's built-in instructions (system
   prompt, tool descriptions) that no file above repeats, whatever its consequence, and never as
   "rule còn thiếu": Viet cannot change them.
3. Per failure pattern, `ls ~/Desktop/kaizen-*`: a file already has it → add a `## Lần lặp`
   entry there. Otherwise write `~/Desktop/kaizen-<yymmdd>-<slug>.md` (Vietnamese):
   - `# <one-line title>`, then `Phiên: <task> (session <id>)`.
   - `## Chuyện đã xảy ra`: timed steps, Viet's words quoted, and what it cost him (time, rework,
     a decision made on a wrong answer). A secret the transcript shows is written `[redacted]`.
   - `## Rule đã phạm`: the exact sentence and its file, or "rule còn thiếu".
   - `## Mẫu lỗi chung`: the mechanism, and why no check caught it.
   - `## Hướng kaizen`: each fix and the file it belongs in. A fix works unremembered (hook,
     script, safe default, a `knowledge/` fact) or tightens a rule sentence; "be more careful"
     fixes nothing.
   The final report says how many files were written, or that the transcript held none.
4. Never offer to apply a kaizen; Viet opens a session for that. A harness defect met during other
   work gets no fix, PR or ask to open one in that session.
5. In a kaizen session no file is written: a harness defect or a mistake of yours met there is
   fixed in that session, with no ask, once the topic at hand closes (Viet opened the session
   for this; a new file costs him another session).

## Apply kaizen files (a session where Viet opens them)

- Discuss each file with Viet; he decides. Then fix: tighten an existing sentence (add one only
  when grep finds none), within the `rules-budget` caps; no rule names an incident or its date;
  an example stays only when the rule is unclear without it. Before another "don't", weigh a
  "do" sentence or an automatic check: rules made only of restraints teach stopping early.
- The harness guides; the work's output is what counts, and every block costs the agent a read and
  a retry. A slip seen once is fixed by a sentence; a hook only for one that recurs and spoils
  output. A hook blocks only where a wrong step reaches someone else or cannot be undone (a merge, a
  send, a secret, a production write, a session the user cannot type into); anything else is a
  reminder said once (context back, or `hooks/lib/block-once.cjs` when it must land before the
  command runs). Never chase every route around a check.
- A fix lands where it holds: a repo's convention in that repo (its PR), a fact about this machine
  or Viet's setup in `~/.claude/knowledge/`, a skill only what holds on any machine;
  `tests/skills-generic.test.cjs` fails on the common marks (a home or app-data path, an Orca ID, a
  dated event, a numbered issue link, a name from the local denylist in `~/.claude/knowledge/`).
- Check each fix at its own layer (a hook: fixtures that hit and miss), then delete that kaizen
  file. No log of past mistakes is kept.
