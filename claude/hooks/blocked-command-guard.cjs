#!/usr/bin/env node
/**
 * blocked-command-guard.cjs - a command auto mode denied never reaches the user wrapped in a script
 * (rules/mine/user-profile.md: the `**Cần bạn:**` line asks the user to allow its exact command).
 * - PermissionDenied(Bash): remember the denied command for this session, as its key: the last
 *   step (split at newline, `&&`, `||`, `;`) that is not boilerplate (`# Gate:` comments, `cd`,
 *   `set`, `export`, `source`), with a trailing redirect or `| tee` dropped. Earlier steps are
 *   left out: they are usually reads (`git status`) that any script may carry.
 * - PreToolUse(Write|Edit|MultiEdit|NotebookEdit|Bash): block a script that carries a key: the
 *   new text of a file that is not .md, or a Bash call that writes a file (`>`, `tee`, heredoc;
 *   a .md target too when the same call runs a file with a shell) or hands text to a shell
 *   (`bash -c`, `sh -c`, `eval`, `| sh`). The denied command run again (redirect or `tee` at its
 *   end allowed) is left to the classifier: one retry is allowed. Limit: a .md written in one call
 *   and run by a shell in a later one is not caught.
 * Only auto-mode denials fire PermissionDenied; a hook's own block is not remembered. Fails open.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const STATE_DIR = path.join(os.tmpdir(), 'claude-denied-commands');
const MAX_KEPT = 20;
const MIN_KEY = 8;
const BOILERPLATE = /^(#|(set|cd|export|source|\.)(\s|$))/;
const TAIL_OUTPUT = /\s*(2>&1)?\s*(\|\s*tee\b.*|>>?\s*\S+)\s*$/;
const WRITES_FILE = /(^|[^0-9&>=-])>{1,2}\s*[^\s&>]|\btee\b|<<-?\s*['"]?\w/;
const RUNS_TEXT = /\b(ba|z)?sh\s+-c\b|\beval\b|\|\s*(ba|z)?sh\b/;
const WRITE_TARGET = /(?:(?:^|[^0-9&>=-])>{1,2}|\btee\s+(?:-a\s+)?)\s*['"]?([^\s'";&|<>]+)/g;
const PROSE_FILE = /\.md$/i;
const RUNS_FILE = /(^|[;&|(\s])((ba|z)?sh|source|\.)\s+[^\s-]/;

const squash = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const steps = (command) =>
  String(command || '').replace(/\\\r?\n/g, ' ').split(/\n|&&|\|\||;/).map(squash).filter(Boolean);

const own = (command) => steps(command).filter((s) => !BOILERPLATE.test(s)).map((s) => s.replace(TAIL_OUTPUT, ''));

function keysOf(command) {
  const main = own(command).pop();
  return main && main.length >= MIN_KEY ? [main] : [];
}

const stateFile = (sessionId) => path.join(STATE_DIR, `${String(sessionId).replace(/[^\w-]/g, '_')}.jsonl`);
function remembered(sessionId) {
  let lines = [];
  try { lines = fs.readFileSync(stateFile(sessionId), 'utf8').split('\n').filter(Boolean); } catch { return []; }
  return lines.slice(-MAX_KEPT).flatMap((l) => { try { return JSON.parse(l); } catch { return []; } });
}
function remember(sessionId, command) {
  const keys = keysOf(command);
  if (!keys.length) return;
  fs.mkdirSync(STATE_DIR, { recursive: true });
  // One short line per denial: an append is atomic, so parallel denials do not overwrite each other.
  fs.appendFileSync(stateFile(sessionId), JSON.stringify(keys) + '\n');
}

// Text a tool call would put into a script, or null when it writes none.
function scriptText(tool, input) {
  if (['Write', 'Edit', 'MultiEdit'].includes(tool) && PROSE_FILE.test(input.file_path || '')) return null;
  if (tool === 'Write') return input.content || '';
  if (tool === 'Edit') return input.new_string || '';
  if (tool === 'MultiEdit') return (input.edits || []).map((e) => e.new_string || '').join('\n');
  if (tool === 'NotebookEdit') return input.new_source || '';
  if (tool !== 'Bash') return null;
  const cmd = input.command || '';
  if (RUNS_TEXT.test(cmd)) return cmd;
  if (!WRITES_FILE.test(cmd)) return null;
  const targets = [...cmd.matchAll(WRITE_TARGET)].map((m) => m[1]);
  return targets.length && targets.every((t) => PROSE_FILE.test(t)) && !RUNS_FILE.test(cmd) ? null : cmd;
}

function hit(keys, tool, input) {
  input = input || {};
  const text = scriptText(tool, input);
  if (text === null || !keys.length) return null;
  if (tool === 'Bash') {
    const mine = own(text);
    if (mine.length && mine.every((s) => keys.includes(s))) return null;
  }
  const body = squash(text);
  return keys.find((k) => body.includes(k)) || null;
}

if (require.main === module) {
  let raw = '';
  process.stdin.on('data', (c) => (raw += c));
  process.stdin.on('end', () => {
    try {
      const data = JSON.parse(raw);
      const sid = data.session_id;
      if (!sid) process.exit(0);
      if (data.hook_event_name === 'PermissionDenied') {
        if (data.tool_name === 'Bash') remember(sid, (data.tool_input || {}).command);
        process.exit(0);
      }
      const key = hit(remembered(sid), data.tool_name, data.tool_input);
      if (key) {
        process.stderr.write(
          `blocked-command-guard: this puts "${key.slice(0, 120)}", which auto mode denied this session, ` +
            'into a script. That is another route with the same effect (rules/mine/user-profile.md). ' +
            'Park that step; the **Cần bạn:** line asks the user to allow its exact command (the permission rule, ' +
            'its impact), not to approve it.\n'
        );
        process.exit(2);
      }
    } catch (_) { /* fail-open */ }
    process.exit(0);
  });
}

module.exports = { keysOf, hit, scriptText };
