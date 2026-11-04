---
name: ntv-kaizen
description: "Record a mistake as one file on the Desktop for Viet's next kaizen session. Use it yourself, without asking, when you (1) break a sentence of ~/.claude/CLAUDE.md, ~/.claude/rules/mine/*.md or a file they point to (watch.sh --help…), (2) Viet corrects you a second time on the same matter this session, (3) a mistake had a real consequence (a tier B/C action done wrong, Viet had to interrupt, block or undo), or (4) you meet a defect of the harness itself (hook, rule, skill). Also load it before the first edit when Viet types /ntv-kaizen or asks to read, check or discuss the kaizen files on the Desktop (`kaizen-*.md`, \"check kaizen ở desktop\"): that is a kaizen session, which applies each file and then deletes it."
---

# /ntv-kaizen

## Record a mistake

1. Outside the four triggers in the description, a mistake is one line in the final report,
   no file. A slip you undid in the same turn, before Viet saw it, is no mistake.
2. A kaizen file never settles a mistake: first fix the task's output (never the harness) in this turn (redo the check,
   correct the answer), then name it in the report at full severity, with no mitigating fact,
   and return to the topic Viet is on.
3. Before writing, `ls ~/Desktop/kaizen-*`: the same failure pattern already has a file → add a
   `## Lần lặp` entry there. Otherwise write `~/Desktop/kaizen-<yymmdd>-<slug>.md` (Vietnamese):
   - `# <one-line title>`, then `Phiên: <task> (session <id>)`.
   - `## Chuyện đã xảy ra`: timed steps, Viet's words quoted, and what it cost him (time, rework,
     a decision made on a wrong answer).
   - `## Rule đã phạm`: the exact sentence and its file, or "rule còn thiếu".
   - `## Mẫu lỗi chung`: the mechanism, and why no check caught it.
   - `## Hướng kaizen`: each fix and the file it belongs in. A fix works unremembered (hook,
     script, safe default, a `knowledge/` fact) or tightens a rule sentence; "be more careful"
     fixes nothing.
4. Never offer to apply a kaizen; Viet opens a session for that. A defect of the harness itself
   (hook, rule, skill) met during any work, a mistake of yours or not, is a kaizen file the same
   way (`## Rule đã phạm`: "lỗi của harness"): no fix, PR or ask to open one in that session.

## Apply kaizen files (a session where Viet opens them)

- Discuss each file with Viet; he decides. Then fix: tighten an existing sentence (add one only
  when grep finds none), within the `rules-budget` caps; no rule names an incident or its date;
  an example stays only when the rule is unclear without it. Before another "don't", weigh a
  "do" sentence or an automatic check: rules made only of restraints teach stopping early.
- A fix lands where it holds: a repo's convention in that repo (its PR), a fact about this machine
  or Viet's setup in `~/.claude/knowledge/`, a skill only what holds on any machine;
  `tests/skills-generic.test.cjs` fails on the common marks (a home or app-data path, an Orca ID, a
  dated event, a numbered issue link, a name from the local denylist in `~/.claude/knowledge/`).
- Check each fix at its own layer (a hook: fixtures that hit and miss), then delete that kaizen
  file. No log of past mistakes is kept.
