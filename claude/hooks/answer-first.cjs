#!/usr/bin/env node
/**
 * answer-first.cjs - PreToolUse(*): handle a message the user sent mid-turn that has had
 * no reply text yet. The harness records it as a `queued_command` attachment with
 * `origin.kind: "human"`; any assistant text block after it counts as the reply.
 * Never blocks; what it says comes back as additionalContext, so the reply can still put it right:
 * - A question with no reply text yet (CLAUDE.md § Mutation gate: a message with a question is
 *   answered first): the answer goes in the turn's last text, after the last tool call, and in
 *   the AskUserQuestion question when the turn asks (communication-style.md § Format): a chat
 *   client may fold text written before a tool call out of sight, so an answer placed there alone
 *   reads as ignored. Any text now (a line saying the answer comes at the end) stops the reminder.
 * - Anything else (an instruction, a notice): the first tool call after it gets the message back so
 *   it is acted on and acknowledged.
 * Fails open whenever the transcript cannot be read.
 */
const fs = require('fs');
const { isQuestion, promptText } = require('./lib/user-intent.cjs');

const TAIL_BYTES = 512 * 1024;

function tailLines(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n');
    if (start > 0) lines.shift(); // first line may be cut
    return lines;
  } finally {
    fs.closeSync(fd);
  }
}

const blocks = (rec) => (rec.type === 'assistant' && rec.message?.content) || [];
const hasText = (rec) => blocks(rec).some((b) => b.type === 'text' && b.text.trim());
const hasToolUse = (rec) => blocks(rec).some((b) => b.type === 'tool_use');

const isTurnStart = (rec) => promptText(rec) !== null;

// The latest mid-turn human message with no reply text yet, as { prompt, calls }, or null.
// `calls` counts tool_use records after it; the call being checked is already one of them.
function pendingMessage(lines) {
  let calls = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    let rec;
    try { rec = JSON.parse(lines[i]); } catch { continue; }
    if (hasText(rec) || isTurnStart(rec)) return null;
    if (hasToolUse(rec)) calls++;
    const a = rec.type === 'attachment' && rec.attachment;
    if (a && a.type === 'queued_command' && a.origin?.kind === 'human') {
      return { prompt: String(a.prompt || ''), calls };
    }
  }
  return null;
}

let raw = '';
process.stdin.on('data', (c) => (raw += c));

process.stdin.on('end', () => {
  try {
    const { transcript_path: transcript, agent_id: agentId } = JSON.parse(raw);
    if (!transcript || agentId) process.exit(0);
    const notes = [];
    const pending = pendingMessage(tailLines(transcript));
    if (pending && (isQuestion(pending.prompt) || pending.calls <= 1)) {
      const quote = pending.prompt.replace(/\s+/g, ' ').slice(0, 200);
      notes.push(isQuestion(pending.prompt)
        ? `answer-first: the user asked mid-turn ("${quote}") and no reply text followed. ` +
          'Answer it in the turn\'s last text, after your last tool call, and inside the AskUserQuestion question if ' +
          'this turn asks: text before a tool call may be folded out of sight. Say in one line now that the answer comes at the end.'
        : `answer-first: the user wrote mid-turn ("${quote}"). Not a question, so work goes on: ` +
          'follow it if it is an instruction, and acknowledge it in your next text.');
    }
    if (notes.length) {
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: notes.join(' ') } }));
    }
  } catch (_) { /* fail-open: no transcript, unreadable record */ }
  process.exit(0);
});
