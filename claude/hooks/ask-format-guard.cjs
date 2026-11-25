#!/usr/bin/env node
/**
 * ask-format-guard.cjs - PreToolUse(AskUserQuestion): a question longer than one line of its own
 * text (two or more sentences, or a line break: a list, a draft) is held once (communication-style.md
 * § Format: an ask's question is one line standing alone; its context, list and drafts go in the
 * message just before the ask). Orca shows at most 4 lines of a question (2 when the chat pane is
 * short) and scrolls the rest inside the box, while the message before the ask stays in view.
 * A sentence ends at `.`, `?`, `!` or `;` before a space or the end; a colon does not count, so a
 * label ("Plan <path>: …?") stays one point. A short quoted phrase and a roman-numeral label ("II. …")
 * are no sentence of the ask, nor is a ';' inside a parenthesised aside with no sentence of its own;
 * an aside that runs sentences is context, and counts. Said once per question text
 * (lib/block-once.cjs): the same ask sent again passes. Fails open on any error.
 */
'use strict';

const SENTENCE_END = /[.?!;](?=\s|$)/g;
const ROMAN_LABEL = /^\s*[IVX]+\.\s+/gm;

// The ask's own text: quoted drafts and fenced code blocks left out.
const ownText = (t) => t
  .replace(/```[\s\S]*?```/g, ' ')
  .replace(/"[^"]*"/g, ' ')
  .replace(/“[^”]*”/g, ' ');
// What is counted: the own text without roman-numeral labels and asides that hold no `.?!` sentence end.
const counted = (own) => own.replace(/\([^()]*\)/g, (m) => (/[.?!](?=\s|\))/.test(m) ? m : ' ')).replace(ROMAN_LABEL, '');

// The questions of an AskUserQuestion input longer than one line: a line break, or two or more sentences.
function runOnQuestions(input) {
  const qs = Array.isArray(input?.questions) ? input.questions : [];
  return qs
    .map((q) => String(q?.question || ''))
    .filter((t) => /\n/.test(t.trim()) || (counted(ownText(t)).match(SENTENCE_END) || []).length >= 2);
}

const NOTE =
  'ask-format-guard: a question holds more than one line (several sentences, a list or a draft). Orca shows ' +
  'at most 4 lines of it (2 in a short chat pane) and the rest scrolls inside the box. Put the context, the ' +
  'list and any draft in your message just before the ask (it stays in view while the ask waits), and keep ' +
  'the question to one line that names what it decides (communication-style.md § Format); then ask again.';

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
