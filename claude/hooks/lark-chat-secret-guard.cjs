#!/usr/bin/env node
/**
 * lark-chat-secret-guard.cjs - PreToolUse(Bash): `lark-cli im +chat-messages-list|+threads-messages-list|
 * +messages-mget|+messages-search` and `lark-cli mail` reads print what people pasted into a chat or
 * mail verbatim, tokens and passwords included, and once printed a secret is in the conversation and
 * its transcript. Such a read whose output goes straight to the conversation is blocked once with the
 * route: write it to a file in the scratchpad, then read it through ~/.claude/scripts/redact-secrets.cjs.
 * The reads: im `+chat-messages-list|+threads-messages-list|+messages-mget|+messages-search`, mail
 * `+message|+messages|+thread|+triage|+watch`, and raw API `<im|mail> <…messages|threads> get|list|batch_get|mget`.
 * Passes: stdout (not only stderr) redirected to a file, at the read or at the end of its pipe; piped
 * through redact-secrets; `--help`. The same command run again passes (lib/block-once.cjs). Fails open.
 */
'use strict';
const { commands, program, pipedInto } = require('./lib/shell-words.cjs');

const IM_READ = /^\+(chat-messages-list|threads-messages-list|messages-mget|messages-search)$/;
const MAIL_READ = /^\+(message|messages|thread|triage|watch)$/;
const RAW_RESOURCE = /(^|\.)(messages|threads)$/;
const RAW_METHOD = /^(get|list|batch_get|mget)$/;

// True when the command's stdout goes to a file: `>f`, `> f`, `>>f`, `1>f` (never `2>…`, `>__fd2`).
function stdoutToFile(words) {
  for (let i = 0; i < words.length; i++) {
    const m = /^(1?>>?)(.*)$/.exec(words[i]);
    if (!m) continue;
    const target = m[2] || words[i + 1] || '';
    if (target && !target.startsWith('__fd') && target !== '/dev/stderr' && target !== '/dev/stdout') return true;
  }
  return false;
}

// The text of the first chat or mail read in `command` whose output reaches the conversation, else null.
function exposedRead(command) {
  // The parser ends a command at `&`: keep `2>&1`, `>&2` (`__fd<N>`, a descriptor) and `&>` (stdout too) whole.
  const all = commands(String(command).replace(/(\d?)>&(\d)/g, '$1>__fd$2').replace(/&>/g, '>'));
  for (let k = 0; k < all.length; k++) {
    const words = program(all[k]);
    if (words[0] !== 'lark-cli') continue;
    if (words.includes('--help') || words.includes('-h')) continue;
    const verb = words.find((w) => w.startsWith('+')) || '';
    const service = words.find((w) => w === 'im' || w === 'mail');
    const raw = service && words.some((w, i) => RAW_RESOURCE.test(w) && RAW_METHOD.test(words[i + 1] || ''));
    const reads = (service === 'im' && IM_READ.test(verb)) || (service === 'mail' && MAIL_READ.test(verb)) || raw;
    if (!reads) continue;
    const pipe = pipedInto(all, k);
    if (stdoutToFile(words) || (pipe.length && stdoutToFile(pipe[pipe.length - 1]))) continue;
    if (pipe.some((p) => p.some((w) => /redact-secrets/.test(w)))) continue;
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
