#!/usr/bin/env node
/**
 * ask-format-guard.cjs - PreToolUse(AskUserQuestion): a question holding two or more sentences on
 * running lines, with no bullet line, is held once (communication-style.md § Format: each point on
 * its own `- ` line, in an ask's question too). The box shows the question as one block of text, so
 * context, facts and the question run together and the user reads it twice.
 * A sentence ends at `.`, `?`, `!` or `;` before a space or the end; a colon does not count, so a
 * label ("Plan <path>: …?") stays one point. A quoted draft (the message a send ask shows) and a fenced
 * code block are not the ask's own sentences, nor is a roman-numeral label ("II. …") or a ';' inside a
 * parenthesised aside with no sentence of its own, so they are left out before counting; an aside that
 * runs sentences is context, and counts. Said once per question text (lib/block-once.cjs): the same ask sent
 * again passes. Fails open on any error.
 */
'use strict';

const SENTENCE_END = /[.?!;](?=\s|$)/g;
const BULLET_LINE = /^\s*(?:[-*•]|\d+[.)]|\([a-z0-9]\))\s/im;
const ROMAN_LABEL = /^\s*[IVX]+\.\s+/gm;

// The ask's own text: quoted drafts and fenced code blocks left out.
const ownText = (t) => t
  .replace(/```[\s\S]*?```/g, ' ')
  .replace(/"[^"]*"/g, ' ')
  .replace(/“[^”]*”/g, ' ');
// What is counted: the own text without roman-numeral labels and asides that hold no `.?!` sentence end.
const counted = (own) => own.replace(/\([^()]*\)/g, (m) => (/[.?!](?=\s|\))/.test(m) ? m : ' ')).replace(ROMAN_LABEL, '');

// The questions of an AskUserQuestion input that run two or more sentences with no bullet line.
function runOnQuestions(input) {
  const qs = Array.isArray(input?.questions) ? input.questions : [];
  return qs
    .map((q) => String(q?.question || ''))
    .filter((t) => {
      const own = ownText(t);
      return !BULLET_LINE.test(own) && (counted(own).match(SENTENCE_END) || []).length >= 2;
    });
}

const NOTE =
  'ask-format-guard: a question runs several sentences on one block of text. The box shows it as ' +
  'written, so the user reads context, facts and the question run together (communication-style.md ' +
  '§ Format: each point on its own `- ` line, in an ask\'s question too). Put each point on its own ' +
  '`- ` line and send the ask again.';

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
