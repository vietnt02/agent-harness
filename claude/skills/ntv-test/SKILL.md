---
name: ntv-test
description: "How a test earns its place in any repo, how a change proves it works against the real systems it touches, and how a suite is measured, pruned and audited instead of only growing. Load before writing, changing or deleting tests, before reviewing a diff's tests, and when Viet asks whether a repo's tests are worth trusting (`/ntv-test audit`)."
---

# /ntv-test

A green gate proves the code does what its author believed. Production breaks mostly where the
author believed wrong: an external API, real data, the scheduler, a permission. So the suite
answers to two measures, never to its size: the faults it catches (mutation) and the production
breaks it let through (escape rate). The repo's `AGENTS.md` names its test surface and its reality
checks; this skill never invents one for it.

## 1. Admit a test

- Before writing it, name in one line: the behaviour it protects, its authority (a requirement,
  an API's documented or recorded reply, an accepted decision) and the defect it would catch. No
  defect named → no test; a covered refactor adds none.
- A bug fix: the test fails on the code before the fix, for the reason of the bug, then passes
  (`ntv-implement` § Verify).
- It asserts what a caller or a reader of the output observes. Never admitted: a test that only
  checks the source text holds or lacks a string, one that asserts the mock it set up, a snapshot
  of whatever the code returns now.
- A fake of an external system copies a real reply, and says where it came from (a recorded
  response, the vendor's documented example). A reply the author imagined is a hypothesis, and
  the test built on it proves nothing about that system.
- A worker spec that writes tests quotes this section.

## 2. Prove it against reality

A change touching an external system, real data, a schedule or permissions is not proven by the
suite, whatever its colour. It runs the repo's own reality check (a read-only dry run on real
input, a query plan on real data, a recorded-reply refresh) and the PR/MR carries its output. A
repo with no such check for that layer: that layer is `CHƯA kiểm` in the report and the PR/MR
names the missing check; it is never reported green.

## 3. Measure the diff with mutation

Before the non-author review, inject faults into the lines the change touched and run the tests
that reach them, on a disposable copy, never the working tree:

```bash
git diff -U0 <base>...HEAD > <scratch>/change.diff            # commit first: the copy is HEAD
mkdir <scratch>/copy && git archive HEAD | tar -x -C <scratch>/copy
python3 -I ~/.claude/skills/ntv-test/scripts/mutate.py <scratch>/copy <scratch>/mutants.json \
  --module <path.py> --tests <test files…> --diff <scratch>/change.diff
```

- `scripts/mutate.py` covers Python (pytest). Another language uses its own mutation tool on the
  same terms: changed lines only, a fixed sample, a copy.
- Each survivor is judged: equivalent (the mutant behaves the same, e.g. a log text) with its
  reason, or a gap, which gets a test per § 1. The PR/MR lists the kill count and every survivor
  with its verdict. A fault the change cannot reach is no gap.
- The budget is the change: at most 40 mutants per touched module, local, free. Never a CI gate
  on the whole repo.

## 4. Keep the suite lean

- A feature removed takes its tests in the same change.
- A test that kills no sampled fault, or only faults a cheaper test also kills, is a candidate to
  merge, lower to a cheaper layer or retire; never deleted for the suite's size, age or speed alone.
- Retiring or merging tests reruns the same mutants on the remaining suite: every fault killed
  before is still killed, else the change is rejected. Never both of two tests that each look
  redundant with the other.
- A skipped or disabled test carries the reason and what reopens it; one without is fixed or
  removed with that stated.

## 5. Audit a repo (`/ntv-test audit [repo]`)

Read-only, on a fresh `git fetch` and a copy, for Viet who judges by outcome:

1. **Escape rate**: the fix merges over a window (default the last 30 merged fixes), each classed
   by its message and diff: external system behaved otherwise, real data differed from fixtures,
   runtime (scheduler, permissions, connections), business decision, or code logic a test could
   have caught. Report how many the gate could have caught, and which reality check would have.
2. **Kill rate**: `scripts/mutate.py` without `--diff` on 3–5 modules carrying the most business
   logic, 40 mutants each; every non-equivalent survivor named with its business consequence.
3. **Dead weight**: tests per § 1's never-admitted list, skips without reason, tests of removed
   features, each by `file:line`.
4. Report, business first: escape rate, kill rate, the three gaps that cost most, and one
   recommended next step. Each number names its denominator; a class judged from commit messages
   alone says so.
