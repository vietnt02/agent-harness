---
name: ntv-merged
description: "Sync the repo after a PR/MR was merged: fast-forward the default branch to the merged remote state and prune local branches that are fully merged. Invoke only when the user explicitly runs /ntv-merged after a merge."
user-invocable: true
disable-model-invocation: true
when_to_use: "Invoke only on the explicit /ntv-merged command, right after the user's PR/MR has been merged, to update the local default branch and clean up dead local branches."
category: dev-tools
keywords: [merged, sync, default-branch, pull, prune, branch-cleanup, git]
metadata:
  author: vietnt
  version: "1.0.0"
---

# /ntv-merged — post-merge sync & branch cleanup

The user's PR/MR was just merged. Bring the local repo in line with the merged
remote state and prune dead local branches. Work only through the `git` CLI
(Bash). Do **not** hardcode `main` — detect the default branch each time.

## Steps

1. **Detect the default branch** (do not assume `main`):
   ```
   git remote show origin | sed -n 's/.*HEAD branch: //p'
   ```
   Fallback if that is empty: `git symbolic-ref --short refs/remotes/origin/HEAD | sed 's#^origin/##'`,
   then `develop` / `main` / `master` in that order of existence.

2. **Safety — stop on a dirty tree.** Run `git status --porcelain`. If there is
   any uncommitted or staged change, **STOP**: report the dirty files and let
   the user decide (commit or stash). Do not switch, pull, or delete anything.

3. **Fetch with prune:** `git fetch --prune origin`.

4. **Update the default branch (fast-forward only):**
   `git switch <default>` then `git pull --ff-only origin <default>`.
   If `--ff-only` fails (local default has diverging commits), **STOP** and
   report — do not merge, rebase, or reset without asking.

5. **Find prune candidates** — local branches, **excluding the default branch,
   the current branch, and any branch whose name matches `*published`** (those
   hold CI state, e.g. `n8n-published`, not merged work), that are either:
   - **Fully merged:** appear in `git branch --merged <default>`, or
   - **Upstream gone:** marked `[gone]` in `git branch -vv` (their remote
     branch was deleted after merge).

   Note: squash- or rebase-merged branches will **not** show up as `--merged`.
   For a branch that looks done but is not `--merged`, check whether its diff
   against the default branch is empty
   (`git diff --quiet <default>...<branch> && echo EMPTY`) before treating it as
   safe.

6. **Delete safely:**
   - Delete clearly-merged branches with `git branch -d <branch>` (this refuses
     to delete anything not merged, which is the safety net you want).
   - For `[gone]`/squash-merged branches that `-d` refuses but whose diff is
     empty, **list them and ask** before using `git branch -D`. Never force-delete
     unmerged work without explicit confirmation.

7. **Report** concisely: the default branch's new HEAD (short hash + subject),
   which local branches were deleted, and which were skipped and why.

## Guarantees

- Never delete the default branch or the branch you are currently on.
- Never delete a `*published` branch, local or remote: it is a CI state pointer,
  and deleting it breaks publishing. Skip it silently, do not offer to clean it.
- Never force-delete (`-D`) a branch without explicit user confirmation.
- Never touch the working tree when it is dirty.
- Never rebase/reset/merge the default branch on a non-fast-forward pull —
  surface it and let the user choose.
