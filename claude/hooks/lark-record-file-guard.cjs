#!/usr/bin/env node
/**
 * lark-record-file-guard.cjs - PostToolUse(Bash): `lark-cli base +record-get/+record-list/
 * +record-search` writes its records (`record_file`, an .ndjson) and a `manifest_file` into the
 * current directory by default, and a session's cwd is usually a repo root. Base rows can be
 * personal or accounting data, so a file that landed inside a git working tree, not ignored there,
 * gets one reminder to move it out before a `git add` picks it up. Reads the command's output, not
 * its shape: whatever the command looked like, only a file actually written is named.
 * Never blocks and never moves the file itself (the path the agent just read would go stale).
 * Fails open.
 */
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { commands, program } = require('./lib/shell-words.cjs');

const git = (dir, args) =>
  execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();

// Every `record_file` / `manifest_file` path the output names, absolute (a relative one against cwd).
function recordFiles(output, cwd) {
  const out = [];
  for (const m of String(output).matchAll(/"(?:record_file|manifest_file)"\s*:\s*"((?:[^"\\]|\\.)+)"/g)) {
    const p = m[1].replace(/\\(.)/g, '$1');
    out.push(path.resolve(cwd || process.cwd(), p));
  }
  return [...new Set(out)];
}

// The repo root a file sits in when git would track it (inside a working tree, not ignored), else null.
function trackableIn(file) {
  const dir = path.dirname(file);
  if (!fs.existsSync(file)) return null;
  let top;
  try { top = git(dir, ['rev-parse', '--show-toplevel']); } catch (_) { return null; }
  try { git(dir, ['check-ignore', '-q', file]); return null; } catch (_) { return top; }
}

module.exports = { recordFiles, trackableIn };
if (require.main !== module) return;

let raw = '';
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', () => {
  try {
    const { tool_name: tool, tool_input: input = {}, tool_response: res = {}, cwd } = JSON.parse(raw);
    if (tool !== 'Bash') process.exit(0);
    if (!commands(input.command || '').map(program).some((w) => w[0] === 'lark-cli')) process.exit(0);
    const output = typeof res === 'string' ? res : `${res.stdout || ''}\n${res.stderr || ''}`;
    const hits = recordFiles(output, cwd).map((f) => [f, trackableIn(f)]).filter(([, top]) => top);
    if (hits.length) {
      const list = hits.map(([f, top]) => `- ${f} (repo ${top})`).join('\n');
      const context = 'lark-record-file-guard: lark-cli vừa ghi dữ liệu Base vào working tree của repo, ' +
        `git chưa ignore:\n${list}\nChuyển các file này sang scratchpad của phiên (\`mv <file> <scratchpad>/\`) ` +
        'rồi đọc từ đó; lần đọc record sau chạy `cd <scratchpad> && lark-cli …`.';
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: context } }));
    }
  } catch (_) { /* fail-open */ }
  process.exit(0);
});
