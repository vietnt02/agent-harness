---
name: ntv-test
description: "How a test earns its place in any repo, how a change proves it works against the real systems it touches, and how a suite is measured, pruned and audited instead of only growing. Load before writing, changing or deleting tests, before reviewing a diff's tests, before calling done or sending to review a change that alters logic or touches an external system, real data, a schedule or permissions, and when Viet asks whether a repo's tests are worth trusting (`/ntv-test audit`)."
---

# /ntv-test

A green gate proves the code does what its author believed. Production breaks mostly where the
author believed wrong: an external API, real data, the scheduler, a permission. So the suite
answers to two measures, never to its size: the faults it catches (mutation) and the production
breaks it let through (escape rate). The repo's `AGENTS.md` names its test surface and its reality
checks; this skill never invents one for it. A worker task that writes tests, changes logic or
touches those systems quotes §§ 1–3 in its spec; the worker runs § 2 and § 3 before review and its
PR/MR carries the results; the coordinator checks them at the gate (`ntv-orca`).

## 1. Admit a test

- Before writing it, name in one line: the behaviour it protects, its authority (a requirement,
  an API's documented or recorded reply, an accepted decision) and the defect it would catch. No
  defect named → no test; a covered refactor adds none.
- A bug fix: the test fails on the code before the fix, for the reason of the bug, then passes
  (`ntv-implement` § Verify).
- It asserts what a caller or a reader of the output observes. Never admitted: a test that reads
  the source text where it could observe behaviour, one that asserts the mock it set up, a snapshot
  of whatever the code returns now. A guard whose purpose is the text itself (a forbidden pattern,
  a boundary lint, a scan for leftovers) is admitted.
- A fake of an external system copies a real reply, and says where it came from (a recorded
  response, the vendor's documented example). A reply the author imagined is a hypothesis, and
  the test built on it proves nothing about that system.

## 2. Prove it against reality

A change touching an external system, real data, a schedule or permissions is not proven by the
suite, whatever its colour. It runs the repo's own reality check (a read-only dry run on real
input, a query plan on real data, a recorded-reply refresh) and the PR/MR carries its summary:
counts, pass/fail, record IDs, never row data.

A test is only a test: it runs in an isolated environment, with its own copy of every state the
live system reads (its ledger, lock, cursor, config), never the live state, even the system's
own; real input is read, never written. A repo with no way to point a run at such a copy gets one
as part of the change; the check is never skipped for lack of it. Side effects that leave the
machine or reach a person (an OS notification, a sent message, an API write) are blocked by
default in the suite, and a test that needs one fakes it. A check that costs money or spends a vendor's quota
follows `CLAUDE.md` § Verification and claims: planned under one ceiling and approved, never run
ad hoc. A repo with no such check for that layer: that layer is `CHƯA kiểm` in the report and the
PR/MR names the missing check; it is never reported green.

## 3. Measure the diff with mutation

A diff that changes logic in a module (a branch, a comparison, a computation, a returned value)
gets faults injected into its changed lines before the non-author review; a value-only, config,
docs or tests-only diff is exempt. On a disposable copy of the exact commit, never a working tree:

```bash
top=$(git rev-parse --show-toplevel); sha=<commit under review, after git fetch>
git -C "$top" diff -U0 --no-color --no-ext-diff --src-prefix=a/ --dst-prefix=b/ <base>...$sha > <scratch>/change.diff
mkdir <scratch>/copy && git -C "$top" archive $sha | tar -x -C <scratch>/copy
python3 -I ~/.claude/skills/ntv-test/scripts/mutate.py <scratch>/copy <scratch>/mutants.json \
  --module <path.py> --tests <tests reaching it> --confirm-tests <the suite, as it passes> \
  --diff <scratch>/change.diff --python <the repo's interpreter>        # minutes: background
```

- `--tests` are the tests the repo's own change-based selection picks, else those importing the
  module; `--confirm-tests` reruns each survivor on the whole passing suite, so a fault another
  file already kills (`killed_elsewhere`) is no gap.
- `scripts/mutate.py` covers Python (pytest). Another language uses its own mutation tool on the
  same terms: changed lines only, a fixed sample, a copy; a repo with none says so in the PR/MR.
- Each survivor is judged, with its reason: equivalent (it behaves the same, e.g. a log text),
  unreachable (no caller the change serves runs it), or a gap, which gets a test per § 1. The PR/MR lists every result class with its count and every
  survivor with its verdict.
- The budget is the change: at most 40 mutants per touched module, local, free. Never a CI gate
  on the whole repo.

## 4. Keep the suite lean

Applies to tests the change touches; any other finding goes to its own PR/MR (`CLAUDE.md` §
Mutation gate), since deleting tests this work did not write is not this change's scope.

- A feature removed takes its tests in the same change.
- A test whose named defect (§ 1) another test already names and catches is a candidate to merge,
  lower to a cheaper layer or retire; never deleted for the suite's size, age or speed alone, nor
  for a mutation sample alone, which shows what is caught, not what is safe to drop.
- Retiring or merging tests reruns the same mutants (same module, seed and `--confirm-tests`): no
  mutant killed or killed_elsewhere before survives now, else the change is rejected. Never both of two tests that each look redundant with
  the other.
- A skipped or disabled test carries the reason and what reopens it; one without is fixed, or
  removed with that stated.

## 5. Audit a repo (`/ntv-test audit [repo]`)

Read-only, on a fresh `git fetch` and a copy, for Viet who judges by outcome:

1. **Escape rate**: the fix merges over a window (default the last 30 merged fixes), each classed
   by its message and diff: external system behaved otherwise, real data differed from fixtures,
   runtime (scheduler, permissions, connections), business decision, or code logic a test could
   have caught. Report how many the gate could have caught, and which reality check would have.
2. **Kill rate**: `scripts/mutate.py` without `--diff` on 3–5 modules carrying the most business
   logic, 40 mutants each, with `--confirm-tests`; every non-equivalent survivor named with its
   business consequence.
3. **Dead weight**: tests per § 1's never-admitted list, skips without reason, tests of removed
   features, each by `file:line`.
4. Report, business first: escape rate, kill rate, the three gaps that cost most, and one
   recommended next step. Each number names its denominator; a class judged from commit messages
   alone says so.
