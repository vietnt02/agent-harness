#!/usr/bin/env node
/**
 * agent-background-guard.cjs - PreToolUse(Agent|Task): a subagent always runs in the background.
 * A call with `run_in_background: false` blocks the session until the agent ends, and a message
 * the user sends meanwhile is lost. Omitted or true passes. Fails open.
 */
let raw = '';
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', () => {
  try {
    const { tool_input: input } = JSON.parse(raw);
    if (input?.run_in_background === false) {
      process.stderr.write(
        'agent-background-guard: a subagent always runs in the background. Drop `run_in_background: false` ' +
          'and wait for its notification.\n'
      );
      process.exit(2);
    }
  } catch (_) { /* fail-open */ }
  process.exit(0);
});
