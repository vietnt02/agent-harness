#!/usr/bin/env node
/**
 * answer-first.cjs - PreToolUse(*): handle a message the user sent mid-turn that has had
 * no reply text yet. The harness records it as a `queued_command` attachment with
 * `origin.kind: "human"`; any assistant text block after it counts as the reply.
 * - A question blocks the tool call (CLAUDE.md § Mutation gate: a message with a question
 *   is answered first). Visible text clears it; thinking does not.
 * - Anything else (an instruction, a notice) never blocks: the first tool call after it
 *   gets the message back as additionalContext so it is acted on and acknowledged.
 * - AskUserQuestion after an answer already written this turn is blocked: the chat UI folds
 *   text that precedes a tool call into thinking, so the answer would be hidden
 *   (rules/mine/communication-style.md § Format). An answer is a text block with a line
 *   break or over ANSWER_CHARS; the one-line intro before a tool call is not one.
 * The harness writes the assistant records of the current response a moment after the
 * tool call starts (measured ~0.1 s, 2026-10-12), so a reply written right before this
 * call is not on disk yet: before blocking, re-read for up to WAIT_MS.
 * Fails open whenever the transcript cannot be read.
 */
const fs = require('fs');
const { isQuestion, promptText } = require('./lib/user-intent.cjs');

const TAIL_BYTES = 512 * 1024;
const WAIT_MS = 1500;
const POLL_MS = 100;
const ANSWER_CHARS = 200;

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

// Whether this turn holds an answer before the tool_use `id`; null while that call is not on disk.
function answerBefore(lines, id) {
  let seen = false;
  for (let i = lines.length - 1; i >= 0; i--) {
    let rec;
    try { rec = JSON.parse(lines[i]); } catch { continue; }
    if (isTurnStart(rec)) break;
    for (const b of blocks(rec)) {
      if (b.type === 'tool_use' && b.id === id) seen = true;
      else if (seen && b.type === 'text' && (b.text.trim().includes('\n') || b.text.trim().length > ANSWER_CHARS)) return true;
    }
  }
  return seen ? false : null;
}

let raw = '';
process.stdin.on('data', (c) => (raw += c));
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

process.stdin.on('end', () => {
  try {
    const { transcript_path: transcript, agent_id: agentId, tool_name: tool, tool_use_id: id } = JSON.parse(raw);
    if (!transcript || agentId) process.exit(0);
    if (tool === 'AskUserQuestion' && id) {
      let answered = answerBefore(tailLines(transcript), id);
      for (let waited = 0; answered === null && waited < WAIT_MS; waited += POLL_MS) {
        sleep(POLL_MS);
        answered = answerBefore(tailLines(transcript), id);
      }
      if (answered) {
        process.stderr.write(
          'answer-first: this turn already wrote an answer, and text before a tool call is folded ' +
            'into thinking, so the user would not see it. Do not call AskUserQuestion now: end the ' +
            'turn with the answer as its last text and put the question in a `**Cần bạn:**` line.\n'
        );
        process.exit(2);
      }
    }
    let pending = pendingMessage(tailLines(transcript));
    for (let waited = 0; pending && isQuestion(pending.prompt) && waited < WAIT_MS; waited += POLL_MS) {
      sleep(POLL_MS);
      pending = pendingMessage(tailLines(transcript));
    }
    if (pending) {
      const quote = pending.prompt.replace(/\s+/g, ' ').slice(0, 200);
      if (isQuestion(pending.prompt)) {
        process.stderr.write(
          `answer-first: the user asked mid-turn ("${quote}") and no reply text followed. ` +
            'Answer it in visible text (thinking does not count); if the answer needs a read, ' +
            'write one line saying so, then call the tool.\n'
        );
        process.exit(2);
      }
      // Remind only on the first tool call after the message, not on every later one.
      if (pending.calls <= 1) {
        process.stdout.write(JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            additionalContext:
              `answer-first: the user wrote mid-turn ("${quote}"). Not a question, so work goes on: ` +
              'follow it if it is an instruction, and acknowledge it in your next text.',
          },
        }));
      }
    }
  } catch (_) { /* fail-open: no transcript, unreadable record */ }
  process.exit(0);
});
