#!/usr/bin/env node
/**
 * ask-batch-guard.cjs - PreToolUse(AskUserQuestion): an ask after another ask of the same block, with
 * tools run in between, is held once. The user answers an ask and goes back to another app; a second
 * ask a few minutes later waits unseen, and the session stands still (communication-style.md § Format:
 * one ask a block, once nothing else runs or the user writes mid-turn). "Same block": an ask was answered since the user's last
 * typed message; Orca's worker messages and other harness records are not typed messages
 * (lib/user-intent.cjs `promptText`). Asks sent back to back (more than four questions) pass, and so
 * does the first ask after the user types. Said once per answered ask (lib/block-once.cjs, keyed on its
 * tool_use_id): the next ask passes whatever it holds, so the merged ask the note asks for, or a question
 * only the answers raised (a final gate after its open questions), is never held twice.
 * An ask naming the same plan file (`plans/<…>.md`) as the answered one, while that plan is still
 * `status: draft`, passes: ntv-autopilot writes the answers into it, checks its prerequisites again and
 * asks the final gate in the same turn, while the user waits for it. An approved plan runs without asks.
 * The transcript is read from its end in growing pieces until the user's last message or the answered ask
 * shows: a long block (workers running for many minutes) puts both far behind the tail.
 * Fails open whenever the transcript cannot be read.
 */
const fs = require('fs');
const { promptText } = require('./lib/user-intent.cjs');

const TAIL_BYTES = 512 * 1024;
const ASK_ANSWER = /^(Your questions have been answered|The user answered|User has answered)/;

function tailRecords(file, bytes = TAIL_BYTES) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n');
    if (start > 0) lines.shift(); // first line may be cut
    const records = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    records.whole = start === 0;
    return records;
  } finally {
    fs.closeSync(fd);
  }
}

const PLAN_PATH = /plans[\\/][^\s"'`)\]]+\.md/g;
// True when the plan file the question names by a path ending in `rel` (`plans/<…>.md`) is a draft on disk.
const isDraft = (question, rel) => {
  const word = question.split(/[\s"'`()]+/).find((w) => w.replace(/\\+/g, '/').replace(/[:?,.]+$/, '').endsWith(rel));
  if (!word) return false;
  const file = require('./lib/platform.cjs').expandHome(word.replace(/[:?,.]+$/, '').replace(/\.m$/, '.md'));
  try { return /^status:\s*draft\b/m.test(fs.readFileSync(file, 'utf8').split(/^---\s*$/m)[1] || ''); } catch { return false; }
};
const planPaths = (input) => new Set((JSON.stringify(input?.questions || []).match(PLAN_PATH) || []).map((p) => p.replace(/\\+/g, '/')));

// The input of the AskUserQuestion `id` at or before records[i].
function askInput(records, i, id) {
  for (let j = i; j >= 0; j--) {
    const c = records[j].message?.content;
    const use = Array.isArray(c) && c.find((b) => b?.type === 'tool_use' && b.id === id);
    if (use) return use.input;
  }
  return undefined;
}

const resultText = (b) => (typeof b.content === 'string' ? b.content : (b.content || []).map((x) => x?.text || '').join('')).trim();

// The tool_use_id of the ask answered since the user's last typed message when some other tool ran after
// it and `next` (the ask about to run) names none of its plan files, else null; undefined when `records`
// hold neither (read further back).
function spacedAsk(records, next) {
  let toolSince = false;
  for (let i = records.length - 1; i >= 0; i--) {
    const rec = records[i];
    if (promptText(rec) !== null) return null;
    // A message the user typed mid-turn: the parked questions may go now (communication-style.md).
    if (rec.type === 'attachment' && rec.attachment?.type === 'queued_command' && rec.attachment.origin?.kind === 'human') return null;
    const c = rec.message?.content;
    if (!Array.isArray(c)) continue;
    const answered = rec.type === 'user' && c.find((b) => b?.type === 'tool_result' && ASK_ANSWER.test(resultText(b)));
    if (answered) {
      if (!toolSince) return null;
      const want = planPaths(next);
      const text = (next?.questions || []).map((q) => String(q?.question || '')).join('\n');
      const same = [...planPaths(askInput(records, i, answered.tool_use_id))].filter((p) => want.has(p));
      if (same.some((p) => isDraft(text, p))) return null;
      return String(answered.tool_use_id || i);
    }
    if (rec.type === 'assistant' && c.some((b) => b?.type === 'tool_use' && b.name !== 'AskUserQuestion')) toolSince = true;
  }
  return records.whole === false ? undefined : null;
}

// spacedAsk over the transcript, read back from its end until it decides (the whole file at most).
function spacedAskIn(file, next) {
  for (let bytes = TAIL_BYTES; ; bytes *= 4) {
    const records = tailRecords(file, bytes);
    const found = spacedAsk(records, next);
    if (found !== undefined || records.whole) return found || null;
  }
}

const NOTE =
  'ask-batch-guard: an AskUserQuestion was already answered since the user last typed, and tools ran ' +
  'since. The user answers and goes back to other work, so a later ask waits unseen and the session stands ' +
  'still (communication-style.md § Format: one ask a block, once nothing else runs or the user writes mid-turn). If work of this block ' +
  'can still run without this answer, run it first and put this question in the block\'s last ask, with ' +
  'every other question (its drafts in the message just before it); if nothing can run without it, ask it.';

module.exports = { spacedAsk, spacedAskIn };
if (require.main !== module) return;

let raw = '';
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', () => {
  try {
    const input = JSON.parse(raw);
    if (input.tool_name !== 'AskUserQuestion' || !input.transcript_path) process.exit(0);
    const answered = spacedAskIn(input.transcript_path, input.tool_input);
    if (!answered) process.exit(0);
    const { firstTime } = require('./lib/block-once.cjs');
    if (!firstTime(input.session_id, 'ask-batch-guard', answered)) process.exit(0);
    process.stderr.write(`${NOTE}${input.session_id ? ' Said once: the next ask passes, as it is or merged.' : ''}\n`);
    process.exit(2);
  } catch (_) { /* fail-open */ }
  process.exit(0);
});
