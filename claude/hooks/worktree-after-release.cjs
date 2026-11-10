#!/usr/bin/env node
/**
 * worktree-after-release.cjs - PostToolUse(Bash): after `orca orchestration worker-release`,
 * remind to remove the linked worktree the released worker ran in. Only prints the facts and the
 * command; `orca worktree rm` is asynchronous, so removal is checked later, not here.
 * When a dispatch the command names cannot be read, prints that instead of the reminder (a silent
 * hook hid an Orca JSON change before); fails open on anything else.
 * Reads the command's output, not only the command: a dispatch Orca refused to release (still
 * running, `dispatch_inactive`) keeps its worktree, so it gets `worker-stop`, never `worktree rm`.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const { samePath } = require('./lib/platform.cjs');
const { commands, program } = require('./lib/shell-words.cjs');

// Trailing whitespace only: `git status --porcelain` starts a line with a space (` M path`).
const run = (cmd, args, cwd) =>
  execFileSync(cmd, args, { cwd, encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] }).replace(/\s+$/, '');

// The `<id>::<path>` worktree of a worker-show result: the concise view (Orca 1.4.248) has it as
// `workspace`, the full one (and older versions) as `worker.worktreeId`.
const worktreeOf = (result) => String(result?.workspace || result?.worker?.worktreeId || '');

// Path the dispatch ran in, when it is a linked worktree; null for a main checkout, which
// workers also reuse and which must never be removed. Throws when worker-show names no worktree,
// so a JSON shape Orca changed shows up as a warning instead of silence.
function linkedWorktree(dispatch, show = () => run('orca', ['orchestration', 'worker-show', '--dispatch', dispatch, '--json'])) {
  const id = worktreeOf(JSON.parse(show()).result);
  if (!id) throw new Error('worker-show không có `workspace` hay `worker.worktreeId`');
  const dir = id.split('::').pop();
  if (!dir || !fs.existsSync(dir)) return null;
  // Both printed by git in one absolute form: a main checkout has the same git dir and common dir
  // (comparing a resolved relative path failed on Windows short names like RUNNER~1).
  const [gitDir, commonDir] = run('git', ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir'], dir).split('\n');
  return samePath(gitDir, commonDir) ? null : dir;
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

function describe(dispatch, show) {
  const dir = linkedWorktree(dispatch, show);
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

// What the command's output says about each dispatch: a line instead of the reminder when Orca
// refused it (a worker not settled yet; an error naming no dispatch, read only when the call released
// one dispatch, since it cannot be told apart between several), else null.
function refused(dispatch, output, alone = true) {
  const m = output.match(new RegExp(`Dispatch ${dispatch} is (\\S+); only a settled worker can release`));
  if (m) return `${dispatch}: chưa release (worker đang ${m[1]}, chưa settle); worktree giữ nguyên. Muốn dừng: \`orca orchestration worker-stop --dispatch ${dispatch}\`.`;
  if (alone && /"ok"\s*:\s*false|^error:/m.test(output)) return `${dispatch}: worker-release báo lỗi; worktree giữ nguyên, đọc lỗi trước khi gỡ.`;
  return null;
}

module.exports = { linkedWorktree, worktreeOf, describe, openReviews, refused };
if (require.main !== module) return;

let raw = '';
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', () => {
  try {
    const { tool_name: tool, tool_input: input = {}, tool_response: res = {} } = JSON.parse(raw);
    const output = typeof res === 'string' ? res : `${res.stdout || ''}\n${res.stderr || ''}`;
    const command = input.command || '';
    if (tool !== 'Bash') process.exit(0);
    // Only a release that runs: text naming one (a heredoc, a spec, an echo) is no release.
    const released = commands(command).map(program)
      .filter(([cmd, sub, verb]) => cmd === 'orca' && sub === 'orchestration' && verb === 'worker-release')
      .flatMap((w) => w.join(' ').match(/ctx_[0-9a-f]+/g) || []);
    const notes = [];
    const ids = [...new Set(released)];
    const lines = ids
      .map((d) => {
        const no = refused(d, output, ids.length === 1);
        if (no) { notes.push(no); return null; }
        try { return describe(d); } catch (e) {
          return `${d}: không đọc được worktree (${String(e.message || e).slice(0, 120)}); tự tìm bằng ` +
            `\`orca orchestration worker-show --dispatch ${d} --json --full\` rồi gỡ nó.`;
        }
      })
      .filter(Boolean);
    const parts = notes.map((l) => `- ${l}`);
    if (lines.length) {
      parts.unshift('release chỉ đóng terminal, worktree vẫn còn trên đĩa.', ...lines.map((l) => `- ${l}`));
      parts.push('`orca worktree rm` gỡ bất đồng bộ (`ok: true` = đã nhận lệnh): kiểm lại `git worktree list` khoảng 2 phút sau.');
    }
    if (parts.length) {
      const context = `worktree-after-release: ${parts.join('\n')}`;
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: context } }));
    }
  } catch (_) { /* fail-open */ }
  process.exit(0);
});
