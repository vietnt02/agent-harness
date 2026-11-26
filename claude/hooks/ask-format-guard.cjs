#!/usr/bin/env node
/**
 * ask-format-guard.cjs - PreToolUse(AskUserQuestion): a question longer than one line of its own
 * text (two or more sentences, or a line break: a list, a draft) is held once (communication-style.md
 * § Format: an ask's question is one line standing alone; its context, list and drafts go in the
 * message just before the ask). Orca shows at most 4 lines of a question (2 when the chat pane is
 * short) and scrolls the rest inside the box, while the message before the ask stays in view.
 * A sentence ends at `.`, `?`, `!` or `;` before a space or the end; a colon does not count, so a
 * label ("Plan <path>: …?") stays one point. Quoted text on the question's one line and a roman-numeral label ("II. …")
 * are no sentence of the ask, nor is a ';' inside a parenthesised aside with no sentence of its own;
 * an aside that runs sentences is context, and counts. Said once per question text
 * (lib/block-once.cjs): the same ask sent again passes. Also held once: an ask with no text of the
 * reply between it and the last tool result or user message (a first ask with only thinking before
 * it, an ask sent again after a hook held it): the user decides from the text just above the box,
 * never from thinking, which Orca folds into "Thought for Ns". Fails open on any error.
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

// Text Claude writes right before a tool call is stored as a thinking block whose signature decodes to
// hold "narration": the user sees it, so it is text here; other thinking stays hidden.
function isNarration(b) {
  if (b?.type !== 'thinking' || !b.signature) return false;
  try { return Buffer.from(String(b.signature), 'base64').includes('narration'); } catch { return false; }
}

// Whether the reply holds text of its own after the last tool result or user message, before the ask
// `askId`: thinking and other tool calls of the same reply are skipped, and so are the results of those
// calls (Claude Code runs a call of the reply before the next one streams in: text, Edit, its result,
// the ask); true when the tail cannot tell.
function hasContext(records, askId) {
  const replyOf = new Map();
  for (const r of records) {
    if (r?.type !== 'assistant' || !Array.isArray(r?.message?.content)) continue;
    for (const b of r.message.content) if (b?.type === 'tool_use' && b.id) replyOf.set(b.id, r.message.id);
  }
  const reply = askId ? replyOf.get(askId) : undefined;
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i];
    const content = r?.message?.content;
    if (r?.type === 'assistant' && Array.isArray(content)) {
      for (let j = content.length - 1; j >= 0; j--) {
        const b = content[j];
        if ((b?.type === 'text' && String(b.text || '').trim()) || isNarration(b)) return true;
      }
    } else if (r?.type === 'user' && !r.isMeta) {
      if (typeof content === 'string') return false;
      if (!Array.isArray(content)) continue;
      const sibling = (b) => b?.type === 'tool_result' && reply !== undefined && replyOf.get(b.tool_use_id) === reply;
      if (content.some((b) => (b?.type === 'tool_result' && !sibling(b)) || (b?.type === 'text' && String(b.text || '').trim()))) return false;
    }
  }
  return true;
}

function tailRecords(file, bytes = 256 * 1024) {
  const fs = require('fs');
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n');
    if (start > 0) lines.shift();
    return lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } finally {
    fs.closeSync(fd);
  }
}

// The transcript can lag behind the ask: until the ask's own record shows, read it again every POLL_MS,
// for up to WAIT_MS; never shown, the tail cannot tell, so the ask passes.
const WAIT_MS = Math.max(0, Number(process.env.ASK_GUARD_WAIT_MS) || 1000);
const POLL_MS = Math.max(10, Number(process.env.ASK_GUARD_POLL_MS) || 100);
const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const holdsCall = (records, id) => records.some((r) => r?.type === 'assistant' && Array.isArray(r?.message?.content) &&
  r.message.content.some((b) => b?.type === 'tool_use' && b.id === id));
function contextOf(file, askId) {
  const until = Date.now() + WAIT_MS;
  for (;;) {
    const records = tailRecords(file);
    if (!askId || holdsCall(records, askId)) return hasContext(records, askId);
    if (Date.now() >= until) return true;
    sleepMs(POLL_MS);
  }
}

const NO_CONTEXT =
  'ask-format-guard: no text of yours stands between the last tool result (or the user\'s message) and this ask, ' +
  'so the box shows with nothing above it to decide from; thinking is not shown (Orca folds it into "Thought for Ns"). ' +
  'Write the context (what you found, what each option changes) as text right before the ask, then ask again.';

module.exports = { runOnQuestions, hasContext };
if (require.main !== module) return;

let raw = '';
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', () => {
  try {
    const input = JSON.parse(raw);
    if (input.tool_name !== 'AskUserQuestion') process.exit(0);
    const { firstTime } = require('./lib/block-once.cjs');
    const runOn = runOnQuestions(input.tool_input);
    if (runOn.length && firstTime(input.session_id, 'ask-format-guard', runOn.join('\n'))) {
      process.stderr.write(`${NOTE}${input.session_id ? ' Said once: the same ask sent again passes.' : ''}\n`);
      process.exit(2);
    }
    if (input.transcript_path && !contextOf(input.transcript_path, input.tool_use_id) &&
      firstTime(input.session_id, 'ask-format-guard-context', JSON.stringify(input.tool_input?.questions || []))) {
      process.stderr.write(`${NO_CONTEXT}${input.session_id ? ' Said once: the same ask sent again passes.' : ''}\n`);
      process.exit(2);
    }
  } catch (_) { /* fail-open */ }
  process.exit(0);
});
