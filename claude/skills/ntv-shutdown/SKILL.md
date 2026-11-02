---
name: ntv-shutdown
description: The user is going home or shutting the machine down — everything goes off, so wrap up now instead of working on. Invoked only when the user types /ntv-shutdown.
disable-model-invocation: true
---

# /ntv-shutdown

The machine goes off, or what workers run in restarts. Nothing
keeps running, so work in flight dies unless it is saved now. Not this: the user leaves
but the machine stays on → `/ntv-autopilot`.

## This turn

Wrap up now; never keep working while the user waits.

1. Stop workers and waits: Orca workers, background commands, `watch.sh` runs, servers
   you started.
2. Move scratchpad state somewhere durable: the session note (`## Resume`, IDs only), or the repo's own place
   for it when the block allows.
3. Close terminals and worktrees you opened.
4. Report what is left: `**Claude đã làm:**`, then each unfinished item with where it
   stopped and the one thing needed to resume.
