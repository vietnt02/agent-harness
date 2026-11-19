#!/usr/bin/env node
/**
 * ask-batch-guard.cjs - PreToolUse(AskUserQuestion): an ask after another ask of the same block, with
 * tools run in between, is held once. The user answers an ask and goes back to another app; a second
 * ask a few minutes later waits unseen, and the session stands still (communication-style.md § Format:
 * one ask a block, once nothing else runs). "Same block": an ask was answered since the user's last
 * typed message; Orca's worker messages and other harness records are not typed messages
 * (lib/user-intent.cjs `promptText`). Asks sent back to back (more than four questions) pass, and so
 * does the first ask after the user types. Said once (lib/block-once.cjs): the same ask again passes,
 * for a question that only the answers raised (a final gate after its open questions).
 * Fails open whenever the transcript cannot be read.
 */
const fs = require('fs');
const { promptText } = require('./lib/user-intent.cjs');

const TAIL_BYTES = 512 * 1024;
const ASK_ANSWER = /^(Your questions have been answered|The user answered|User has answered)/;

function tailRecords(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n');
    if (start > 0) lines.shift(); // first line may be cut
    return lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } finally {
    fs.closeSync(fd);
  }
}

const resultText = (b) => (typeof b.content === 'string' ? b.content : (b.content || []).map((x) => x?.text || '').join('')).trim();

// True when, since the user's last typed message, an ask was answered and some other tool ran after it.
function spacedAsk(records) {
  let toolSince = false;
  for (let i = records.length - 1; i >= 0; i--) {
    const rec = records[i];
    if (promptText(rec) !== null) return false;
    const c = rec.message?.content;
    if (!Array.isArray(c)) continue;
    if (rec.type === 'user' && c.some((b) => b?.type === 'tool_result' && ASK_ANSWER.test(resultText(b)))) return toolSince;
    if (rec.type === 'assistant' && c.some((b) => b?.type === 'tool_use' && b.name !== 'AskUserQuestion')) toolSince = true;
  }
  return false;
}

const NOTE =
  'ask-batch-guard: an AskUserQuestion was already answered since the user last typed, and tools ran ' +
  'since. The user answers and goes back to other work, so a later ask waits unseen and the session stands ' +
  'still (communication-style.md § Format: one ask a block, once nothing else runs). If work of this block ' +
  'can still run without this answer, run it first and put this question in the block\'s last ask, with ' +
  'every other question and draft; if nothing can run without it, ask it.';

module.exports = { spacedAsk };
if (require.main !== module) return;

let raw = '';
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', () => {
  try {
    const input = JSON.parse(raw);
    if (input.tool_name !== 'AskUserQuestion' || !input.transcript_path) process.exit(0);
    if (!spacedAsk(tailRecords(input.transcript_path))) process.exit(0);
    const { firstTime, again } = require('./lib/block-once.cjs');
    if (!firstTime(input.session_id, 'ask-batch-guard', JSON.stringify(input.tool_input?.questions || []))) process.exit(0);
    process.stderr.write(`${NOTE}${again(input.session_id)}\n`);
    process.exit(2);
  } catch (_) { /* fail-open */ }
  process.exit(0);
});
