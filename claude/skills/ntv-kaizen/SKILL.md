---
name: ntv-kaizen
description: "A hook is a guardrail for the commands agents actually write, never a wall: no attack simulation, no patching variant by variant. Record what this session showed a hook, script, skill or ambiguous rule must fix (harness defects, serious breaks no hook stops, ambiguous rules; never a clear rule merely broken) as files on the Desktop for Viet's next kaizen session, once at session end: when the session note turns `status: done` (the session-notes hook says so), or when Viet asks for it. During the work no file is written: a mistake is fixed in the task's output and named in the report. Also load it before the first edit when Viet types /ntv-kaizen or asks to read, check or discuss the kaizen files on the Desktop (`kaizen-*.md`, \"check kaizen ở desktop\"): that is a kaizen session, which applies each file and then deletes it."
---

# /ntv-kaizen

A hook is a guardrail for the commands agents actually write, never a wall: an agent always finds
another route, and only the permission mode stops one. Agents work toward the user's goal, not
against it: a hook names the risk on the ordinary command and the agent picks a safer route; that is
all it is for. Build a hook, and brief its reviewer, on those common commands; a fix is done when they
hit and miss right. A reviewer's "it can be bypassed with …" is no blocker and opens no round: no
attack simulation, no patching variant by variant. A kaizen that grows a hook for a new variant is
the loop this stops.

## Record a mistake

1. During the work no kaizen file is written, and none is offered: a file never settles a
   mistake. Fix the task's output first in this turn (redo the check, correct the answer), name the
   mistake in the report at full severity with no mitigating fact, and return to Viet's topic.
2. At session end (the note turned `status: done`, or Viet asks), read the session transcript
   (`.jsonl`), never memory, and list only what a hook, script, skill or reworded sentence must
   fix. Rules are text: a clear one is broken now and then, and rewording it fixes nothing.
   - a defect of the harness itself: a hook or script misfired or lacks a step it is the only
     route for, or a skill followed to the letter gave a wrong step (`## Rule đã phạm`: "lỗi của
     harness");
   - a serious break no hook stops yet: a secret printed, a write to production or to data others
     read, a tier-C action done wrong; its `## Hướng kaizen` is that hook, never a sentence;
   - a rule sentence two fair readings of which lead to two different actions; the fix rewords
     that sentence, never adds one.
   Anything else is no file: a command shape a hook missed (a hook catches the common path,
   never every route; only the permission mode is a wall), a clear rule broken without such
   harm, Viet's intent misread (both
   fixed in the session, step 1), or a break of Claude Code's built-in instructions (system
   prompt, tool descriptions) that no rule file repeats, whatever its consequence: Viet cannot
   change them.
3. Per failure pattern, `ls ~/Desktop/kaizen-*`: a file already has it → add a `## Lần lặp`
   entry there. Otherwise write `~/Desktop/kaizen-<yymmdd>-<slug>.md` (Vietnamese):
   - `# <one-line title>`, then `Phiên: <task> (session <id>)`.
   - `## Chuyện đã xảy ra`: timed steps, Viet's words quoted, and what it cost him (time, rework,
     a decision made on a wrong answer). A secret the transcript shows is written `[redacted]`.
   - `## Rule đã phạm`: the exact sentence and its file, or "lỗi của harness".
   - `## Mẫu lỗi chung`: the mechanism, and why no check caught it.
   - `## Hướng kaizen`: each fix and the file it belongs in. A fix works unremembered (hook,
     script, safe default, a `knowledge/` fact) or rewords the ambiguous sentence; "be more
     careful" fixes nothing.
   The final report says how many files were written, or that the transcript held none.
4. Never offer to apply a kaizen; Viet opens a session for that. A harness defect met during other
   work gets no fix, PR or ask to open one in that session.
5. In a kaizen session no file is written: what step 2 would file, met there, is fixed in that
   session, with no ask (anything else only in the task's output, step 1), once the topic at
   hand closes (Viet opened the session for this; a new file costs him another session).

## Apply kaizen files (a session where Viet opens them)

- Discuss each file with Viet; he decides. A file whose cause is a clear rule broken without
  serious harm is closed (deleted) with no change: a break is never fixed by adding or
  tightening a sentence. Otherwise fix per type: the harness defect in its hook, script or skill;
  a serious break with the hook that stops it; an ambiguous sentence reworded within the
  `tools/rules-budget.cjs` caps. No rule names an incident or its date; an example stays only when the
  rule is unclear without it.
- The harness guides; the work's output is what counts, and every block costs the agent a read and
  a retry. A hook blocks only where a wrong step reaches someone else or cannot be undone (a merge, a
  send, a secret, a production write, a session the user cannot type into); anything else is a
  reminder said once (context back, or `hooks/lib/block-once.cjs` when it must land before the
  command runs).
- A fix lands where it holds: a repo's convention in that repo (its PR), a fact about this machine
  or Viet's setup in `~/.claude/knowledge/`, a skill only what holds on any machine;
  `tests/skills-generic.test.cjs` fails on the common marks (a home or app-data path, an Orca ID, a
  dated event, a numbered issue link, a name from the local denylist in `~/.claude/knowledge/`).
- Check each fix at its own layer (a hook: fixtures that hit and miss), then delete that kaizen
  file. No log of past mistakes is kept.
