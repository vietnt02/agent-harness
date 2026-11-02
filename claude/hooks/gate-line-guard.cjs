#!/usr/bin/env node
/**
 * gate-line-guard.cjs - PreToolUse(Bash): a command that changes another machine (ssh running a
 * write/delete/restart, scp or rsync) is blocked until the command (a `# Gate:` comment line or its
 * description) or visible text of the current turn holds `Gate:` (CLAUDE.md § Mutation gate). Edit/Write hooks never see these commands, and
 * the line was skipped there before (2026-10-13, n8n-pg on vps_n8n).
 * Like answer-first.cjs, re-reads the transcript for up to WAIT_MS before blocking, since text
 * written right before the call reaches disk ~0.1 s later. Text written right before a tool call is
 * stored as a paraphrased `narration` thinking block (2026-10-15), so only the call itself is reliable. Subagents are skipped. Fails open.
 * Same gate for git writing into the user's main checkout (merge, pull, reset, checkout, …): a linked
 * worktree passes, since workers and approved work live in their own. Reading the latest code needs
 * only `git fetch` + `git show origin/<b>:<path>`. `git -c core.hooksPath=…` is gated everywhere.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { promptText } = require('./lib/user-intent.cjs');

const TAIL_BYTES = 512 * 1024;
const WAIT_MS = 1500;
const POLL_MS = 100;

const REMOTE_WRITE = new RegExp(
  [
    String.raw`(?:^|[;&|(\n]\s*|\b(?:then|do)\s+)(?:\w+=\S*\s+)*ssh\s.*(\brm\b|\bmv\b|\bcp\b|\bsed\s+-i|\btee\b|\btruncate\b|\bchmod\b|\bchown\b|\bkill(all)?\b|\bpkill\b`,
    String.raw`|\bdocker(-compose)?\s+(rm|stop|kill|restart|start|run|pull|compose\s+(up|down|rm|stop|restart|pull))`,
    String.raw`|\bsystemctl\s+(start|stop|restart|reload|enable|disable)|\b(insert|update|delete|drop|alter|truncate)\s`,
    String.raw`|[^2&]>(?!\s*/dev/null))`,
    String.raw`|^\s*(scp|rsync)\b|[;&|\n]\s*(scp|rsync)\b`,
  ].join(''),
  'is'
);

const ARG = String.raw`(?:"[^"]*"|'[^']*'|\S+)`;
const GIT_LOCAL_WRITE = new RegExp(
  String.raw`(?:^|[;&|(\n]\s*|\b(?:then|do)\s+)git((?:\s+-C\s+${ARG}|\s+-c\s+\S+)*)\s+` +
    String.raw`(?:(?:merge|pull|rebase|reset|checkout|switch|commit|cherry-pick|revert|am|clean|restore)(?![\w-])` +
    String.raw`|stash(?:\s+(?:push|pop|drop|apply|clear)\b|\s*(?:$|[;&|)]))` +
    String.raw`|branch\s+(?:-[dDmM]|--delete|--move)\b|worktree\s+(?:add|remove)\b|tag\s+(?:-d|--delete)\b)`,
  'gm'
);
const HOOKS_OFF = /\bgit\s+(?:\S+\s+)*?-c\s+core\.hookspath=/i;
const unquote = (s) => s.replace(/^(["'])(.*)\1$/, '$2');
const resolveDir = (p, base) => path.resolve(base, unquote(p).replace(/^~(?=\/|$)/, process.env.HOME));

// True when the directory is a repo's main checkout, not a linked worktree.
function isMainCheckout(dir) {
  try {
    const [gitDir, common] = execFileSync(
      'git', ['-C', dir, 'rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir'],
      { encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'] }
    ).trim().split('\n');
    return Boolean(gitDir) && gitDir === common;
  } catch {
    return false;
  }
}

// True when a git write in the command targets a main checkout: its `-C` path, else the last
// `cd <path>` before it, else the hook's cwd.
// A heredoc body is data written somewhere, not a command that runs.
const stripHeredocs = (s) => s.replace(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2\s*(?=\n|$)/g, '<<HEREDOC');

function writesMainCheckout(command, cwd) {
  command = stripHeredocs(command);
  for (const m of command.matchAll(GIT_LOCAL_WRITE)) {
    const dashC = [...m[1].matchAll(new RegExp(String.raw`-C\s+(${ARG})`, 'g'))].pop();
    const cds = [...command.slice(0, m.index).matchAll(new RegExp(String.raw`(?:^|[;&|(\n]\s*)cd\s+(${ARG})`, 'g'))];
    let dir = cwd;
    if (cds.length) dir = resolveDir(cds.pop()[1], cwd);
    if (dashC) dir = resolveDir(dashC[1], dir);
    if (isMainCheckout(dir)) return true;
  }
  return false;
}

function tailLines(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n');
    if (start > 0) lines.shift();
    return lines;
  } finally {
    fs.closeSync(fd);
  }
}

// True once visible assistant text since the user's latest prompt holds `Gate:`.
function gatePrinted(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    let rec;
    try { rec = JSON.parse(lines[i]); } catch { continue; }
    if (promptText(rec) !== null) return false;
    const blocks = (rec.type === 'assistant' && rec.message?.content) || [];
    if (blocks.some((b) => b.type === 'text' && b.text.includes('Gate:'))) return true;
  }
  return false;
}

let raw = '';
process.stdin.on('data', (c) => (raw += c));
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

process.stdin.on('end', () => {
  try {
    const { transcript_path: transcript, agent_id: agentId, tool_input: input, cwd } = JSON.parse(raw);
    const command = String(input?.command || '');
    if (!transcript || agentId) process.exit(0);
    const remote = REMOTE_WRITE.test(command);
    const git = !remote && (HOOKS_OFF.test(command) || writesMainCheckout(command, cwd || process.cwd()));
    if (!remote && !git) process.exit(0);
    if (`${command}\n${input?.description || ''}`.includes('Gate:')) process.exit(0);
    let ok = gatePrinted(tailLines(transcript));
    for (let waited = 0; !ok && waited < WAIT_MS; waited += POLL_MS) {
      sleep(POLL_MS);
      ok = gatePrinted(tailLines(transcript));
    }
    if (!ok) {
      process.stderr.write(
        (git
          ? 'gate-line-guard: this command writes into the user\'s main git checkout (or turns git hooks off) and this turn has no `Gate:` line. ' +
            'To read the latest code: `git fetch`, then `git show origin/<b>:<path>` / `git grep … origin/<b>`; never fast-forward their checkout. '
          : 'gate-line-guard: this command changes another machine and this turn has no `Gate:` line. ') +
          'Put `# Gate: mở bởi "<the user\'s sentence>" → khối <X>` as a comment line in the command, then rerun ' +
          '(text written before a call is not kept verbatim). If it only reads, `# Gate: không áp (chỉ đọc)`.\n'
      );
      process.exit(2);
    }
  } catch (_) { /* fail-open */ }
  process.exit(0);
});
