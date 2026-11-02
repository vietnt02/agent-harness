#!/usr/bin/env node
/**
 * worktree-after-release.cjs - PostToolUse(Bash): after `orca orchestration worker-release`,
 * remind to remove the linked worktree the released worker ran in. Only prints the facts and the
 * command; `orca worktree rm` is asynchronous, so removal is checked later, not here.
 * Fails open whenever the dispatch or worktree cannot be resolved.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { samePath } = require('./lib/platform.cjs');

const run = (cmd, args, cwd) =>
  execFileSync(cmd, args, { cwd, encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();

// Path the dispatch ran in, when it is a linked worktree; null for a main checkout, which
// workers also reuse and which must never be removed.
function linkedWorktree(dispatch) {
  const { worker } = JSON.parse(run('orca', ['orchestration', 'worker-show', '--dispatch', dispatch, '--json'])).result;
  const dir = (worker.worktreeId || '').split('::').pop();
  if (!dir || !fs.existsSync(dir)) return null;
  const [gitDir, commonDir] = run('git', ['rev-parse', '--absolute-git-dir', '--git-common-dir'], dir).split('\n');
  return samePath(path.resolve(dir, commonDir), gitDir) ? null : dir;
}

function openReviews(dir) {
  const branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], dir);
  if (/gitlab/.test(run('git', ['remote', 'get-url', 'origin'], dir))) {
    const mrs = JSON.parse(run('glab', ['mr', 'list', '--source-branch', branch, '-F', 'json'], dir));
    return mrs.map((m) => `!${m.iid}`);
  }
  const prs = JSON.parse(run('gh', ['pr', 'list', '--head', branch, '--state', 'open', '--json', 'number'], dir));
  return prs.map((p) => `#${p.number}`);
}

function describe(dispatch) {
  const dir = linkedWorktree(dispatch);
  if (!dir) return null;
  const keep = [];
  const dirty = run('git', ['status', '--porcelain'], dir).split('\n').filter(Boolean);
  if (dirty.length) keep.push(`${dirty.length} file chưa commit (${dirty.slice(0, 5).map((l) => l.slice(3)).join(', ')})`);
  const unpushed = run('git', ['rev-list', '--count', 'HEAD', '--not', '--remotes'], dir);
  if (unpushed !== '0') keep.push(`${unpushed} commit chưa push`);
  try {
    const open = openReviews(dir);
    if (open.length) keep.push(`PR/MR mở ${open.join(', ')}`);
  } catch (_) {
    keep.push('không kiểm được PR/MR');
  }
  const rm = `orca worktree rm --worktree path:${dir} --force`;
  return keep.length
    ? `${dispatch}: worktree ${dir} còn ${keep.join('; ')}. Xử lý xong (file cần giữ chép ra scratchpad) rồi gỡ: ${rm}`
    : `${dispatch}: gỡ worktree ${dir}: ${rm}`;
}

module.exports = { linkedWorktree, describe, openReviews };
if (require.main !== module) return;

let raw = '';
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', () => {
  try {
    const { tool_name: tool, tool_input: input = {} } = JSON.parse(raw);
    const command = input.command || '';
    if (tool !== 'Bash' || !/\borca\s+orchestration\s+worker-release\b/.test(command)) process.exit(0);
    const lines = [...new Set(command.match(/ctx_[0-9a-f]+/g) || [])]
      .map((d) => { try { return describe(d); } catch (_) { return null; } })
      .filter(Boolean);
    if (lines.length) {
      const context =
        'worktree-after-release: release chỉ đóng terminal, worktree vẫn còn trên đĩa.\n' +
        lines.map((l) => `- ${l}`).join('\n') +
        '\n`orca worktree rm` gỡ bất đồng bộ (`ok: true` = đã nhận lệnh): kiểm lại `git worktree list` khoảng 2 phút sau.';
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: context } }));
    }
  } catch (_) { /* fail-open */ }
  process.exit(0);
});
