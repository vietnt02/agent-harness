#!/usr/bin/env node
/**
 * ask-format-guard.cjs - PreToolUse(AskUserQuestion): a question holding two or more sentences on
 * running lines, with no bullet line, is held once (communication-style.md § Format: each point on
 * its own `- ` line, in an ask's question too). The box shows the question as one block of text, so
 * context, facts and the question run together and the user reads it twice.
 * A sentence ends at `.`, `?`, `!` or `;` before a space or the end; a colon does not count, so a
 * label ("Plan <path>: …?") stays one point. Said once per question text (lib/block-once.cjs): the
 * same ask sent again passes. Fails open on any error.
 */
'use strict';

const SENTENCE_END = /[.?!;](?=\s|$)/g;
const BULLET_LINE = /^\s*(?:[-*•]|\d+[.)])\s/m;

// The questions of an AskUserQuestion input that run two or more sentences with no bullet line.
function runOnQuestions(input) {
  const qs = Array.isArray(input?.questions) ? input.questions : [];
  return qs
    .map((q) => String(q?.question || ''))
    .filter((t) => !BULLET_LINE.test(t) && (t.match(SENTENCE_END) || []).length >= 2);
}

const NOTE =
  'ask-format-guard: a question runs several sentences on one block of text. The box shows it as ' +
  'written, so the user reads context, facts and the question run together (communication-style.md ' +
  '§ Format: each point on its own `- ` line, in an ask\'s question too). Put each point on its own ' +
  '`- ` line, the question itself last, and send the ask again.';

module.exports = { runOnQuestions };
if (require.main !== module) return;

let raw = '';
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', () => {
  try {
    const input = JSON.parse(raw);
    if (input.tool_name !== 'AskUserQuestion') process.exit(0);
    const runOn = runOnQuestions(input.tool_input);
    if (!runOn.length) process.exit(0);
    const { firstTime } = require('./lib/block-once.cjs');
    if (!firstTime(input.session_id, 'ask-format-guard', runOn.join('\n'))) process.exit(0);
    process.stderr.write(`${NOTE}${input.session_id ? ' Said once: the same ask sent again passes.' : ''}\n`);
    process.exit(2);
  } catch (_) { /* fail-open */ }
  process.exit(0);
});
