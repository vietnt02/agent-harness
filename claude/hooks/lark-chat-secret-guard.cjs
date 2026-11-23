#!/usr/bin/env node
/**
 * lark-chat-secret-guard.cjs - PreToolUse(Bash): `lark-cli im +chat-messages-list|+threads-messages-list|
 * +messages-mget|+messages-search` and `lark-cli mail` reads print what people pasted into a chat or
 * mail verbatim, tokens and passwords included, and once printed a secret is in the conversation and
 * its transcript. Such a read whose output goes straight to the conversation is blocked once with the
 * route: write it to a file in the scratchpad, then read it through ~/.claude/scripts/redact-secrets.cjs.
 * Passes: output redirected to a file, or piped through redact-secrets. The same command run again
 * passes (lib/block-once.cjs). Fails open.
 */
'use strict';
const { commands, program, pipedInto } = require('./lib/shell-words.cjs');

const IM_READ = /^\+(chat-messages-list|threads-messages-list|messages-mget|messages-search)$/;
const MAIL_READ = /^\+[\w-]*(get|list|search|read|fetch)[\w-]*$/;

// The text of the first chat or mail read in `command` whose output reaches the conversation, else null.
function exposedRead(command) {
  const all = commands(command);
  for (let k = 0; k < all.length; k++) {
    const words = program(all[k]);
    if (words[0] !== 'lark-cli') continue;
    const verb = words.find((w) => w.startsWith('+')) || '';
    const reads = (words.includes('im') && IM_READ.test(verb)) || (words.includes('mail') && MAIL_READ.test(verb));
    if (!reads) continue;
    if (words.some((w) => /^(\d?>|&>)/.test(w))) continue;
    if (pipedInto(all, k).some((p) => p.some((w) => /redact-secrets/.test(w)))) continue;
    return words.join(' ');
  }
  return null;
}

module.exports = { exposedRead };
if (require.main !== module) return;

let raw = '';
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', () => {
  try {
    const { tool_input: input, session_id: sessionId } = JSON.parse(raw);
    const command = String(input?.command || '');
    if (!exposedRead(command)) process.exit(0);
    const { firstTime, again } = require('./lib/block-once.cjs');
    if (!firstTime(sessionId, 'lark-chat-secret-guard', command)) process.exit(0);
    process.stderr.write(
      'lark-chat-secret-guard: this read prints chat or mail text as written, and people paste tokens and ' +
        'passwords there. Write it to a file in the scratchpad (`> <scratchpad>/msgs.json`), then read it through ' +
        '`node ~/.claude/scripts/redact-secrets.cjs < <file>`; or pipe the read into that script.' + again(sessionId) + '\n'
    );
    process.exit(2);
  } catch (_) { /* fail-open */ }
  process.exit(0);
});
