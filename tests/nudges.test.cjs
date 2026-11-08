/**
 * tests/nudges.test.cjs - the harness guides: checks that only shape process say it once and let the
 * call through; checks that guard what reaches others or locks the session still block.
 * Runs with `node --test "tests/*.test.cjs"`.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const HOOKS = path.join(__dirname, '..', 'claude', 'hooks');
const sid = (name) => `nudge-${name}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

// Runs a hook with a payload, HOME pointed at `home` when given.
function hook(name, payload, home) {
  const env = { ...process.env };
  if (home) Object.assign(env, { HOME: home, USERPROFILE: home });
  return spawnSync(process.execPath, [path.join(HOOKS, name)], { input: JSON.stringify(payload), encoding: 'utf8', env });
}
const context = (r) => {
  if (!r.stdout.trim()) return '';
  return JSON.parse(r.stdout).hookSpecificOutput?.additionalContext || '';
};
function transcriptWith(dir, text = 'sửa đi') {
  const t = path.join(dir, 't.jsonl');
  fs.writeFileSync(t, JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n');
  return t;
}

test('block-once: the first run of a command is held, the same command again passes', () => {
  const { firstTime } = require('../claude/hooks/lib/block-once.cjs');
  const s = sid('once');
  assert.equal(firstTime(s, 'h', 'ssh a reboot'), true);
  assert.equal(firstTime(s, 'h', 'ssh a reboot'), false);
  assert.equal(firstTime(s, 'h', 'ssh b reboot'), true, 'another command is held once too');
  assert.equal(firstTime(s, 'other', 'ssh a reboot'), true, 'each hook keeps its own memory');
  assert.equal(firstTime(s, 'h', 'ssh a reboot', Date.now() + 11 * 60 * 1000), true, 'held again after the TTL');
  assert.equal(firstTime('', 'h', 'x'), true, 'no session: always held');
});

test('rules-budget after Bash: a nudge once, only for a rule file just written', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nudge-rb-'));
  try {
    fs.mkdirSync(path.join(home, '.claude', 'rules', 'mine'), { recursive: true });
    const md = path.join(home, '.claude', 'CLAUDE.md');
    fs.writeFileSync(md, 'x'.repeat(8300));
    const s = sid('rb');
    const run = (session) => hook('rules-budget.cjs', { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, session_id: session }, home);
    const first = run(s);
    assert.equal(first.status, 0, first.stderr);
    assert.match(context(first), /CLAUDE\.md 8300\/8200/);
    assert.equal(run(s).stdout.trim(), '', 'the same version is told once');
    const old = (Date.now() - 60 * 60 * 1000) / 1000;
    fs.utimesSync(md, old, old);
    const other = run(sid('rb2'));
    assert.equal(other.status, 0);
    assert.equal(other.stdout.trim(), '', 'a file left over budget long ago is not this session\'s business');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('coordinator-read-guard: the third read runs, with one reminder per turn', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nudge-crg-'));
  try {
    const watched = path.join(home, 'repos');
    fs.mkdirSync(watched);
    fs.mkdirSync(path.join(home, '.claude', 'knowledge'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'knowledge', 'coordinator-reads.txt'), `${watched}\n`);
    const transcript = transcriptWith(home, 'bảng này đã có chưa');
    const s = sid('crg');
    const base = { session_id: s, transcript_path: transcript, cwd: home };
    hook('coordinator-read-guard.cjs', { ...base, hook_event_name: 'UserPromptSubmit', prompt: 'bảng này đã có chưa' }, home);
    const read = (i) => hook('coordinator-read-guard.cjs', { ...base, hook_event_name: 'PreToolUse', tool_name: 'Read',
      tool_use_id: `tu_${i}`, tool_input: { file_path: path.join(watched, `f${i}`) } }, home);
    for (const i of [1, 2]) {
      const r = read(i);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(context(r), '', `read ${i} is quiet`);
    }
    const third = read(3);
    assert.equal(third.status, 0, 'the third read is not denied');
    assert.match(context(third), /read 3 of a watched place/);
    const fourth = read(4);
    assert.equal(fourth.status, 0);
    assert.equal(context(fourth), '', 'said once this turn');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('worker-default-guard: an edit in a repo runs, with one reminder per repo', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nudge-wdg-'));
  try {
    const repo = path.join(home, 'app');
    fs.mkdirSync(repo);
    execFileSync('git', ['init', '-q', repo]);
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    const transcript = transcriptWith(home);
    const s = sid('wdg');
    const edit = (file) => hook('worker-default-guard.cjs', { session_id: s, transcript_path: transcript, cwd: repo,
      hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: path.join(repo, file), old_string: 'a', new_string: 'b' } }, home);
    const first = edit('a.js');
    assert.equal(first.status, 0, first.stderr);
    assert.match(context(first), /the change goes ahead/);
    const second = edit('b.js');
    assert.equal(second.status, 0);
    assert.equal(context(second), '', 'the same repo is reminded once');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('gate-line-guard: a remote write with no Gate line is held once', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nudge-glg-'));
  try {
    const transcript = transcriptWith(dir);
    const s = sid('glg');
    const run = () => hook('gate-line-guard.cjs', { session_id: s, transcript_path: transcript, cwd: dir,
      tool_name: 'Bash', tool_input: { command: "ssh web1 'sudo systemctl restart nginx'" } });
    const first = run();
    assert.equal(first.status, 2);
    assert.match(first.stderr, /Gate:.*run it again unchanged/s);
    assert.equal(run().status, 0, 'run again, it passes');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('watch-guard: an unwatched loop is held once; a session lock is always blocked', () => {
  const s = sid('wg');
  const run = (input) => hook('watch-guard.cjs', { session_id: s, cwd: os.tmpdir(), tool_name: 'Bash', tool_input: input });
  const loop = { command: 'while true; do ls; sleep 5; done', run_in_background: true };
  assert.equal(run(loop).status, 2);
  assert.equal(run(loop).status, 0, 'the same loop again passes');
  const lock = { command: 'npm test', timeout: 300000 };
  assert.equal(run(lock).status, 2);
  assert.equal(run(lock).status, 2, 'a foreground lock stays blocked');
});

test('dispatch-split-guard: a split hint never blocks; a missing --effort still does', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nudge-dsg-'));
  try {
    const transcript = transcriptWith(dir, 'giao worker đi');
    const run = (command) => hook('dispatch-split-guard.cjs', { session_id: sid('dsg'), transcript_path: transcript, cwd: dir,
      tool_name: 'Bash', tool_input: { command } });
    const spec = '--spec "Rà; chạy orca orchestration check --peek sau mỗi 10 lệnh"';
    const bundled = run(`# Track: w1 ← sửa gui [gui/a.py] | sửa api [api/b.py]\norca orchestration worker-start ${spec} --agent antigravity --model gemini-3.8-flash --effort high`);
    assert.equal(bundled.status, 0, bundled.stderr);
    assert.match(context(bundled), /share no source file/);
    const bare = run(`orca orchestration worker-start ${spec} --agent antigravity --model gemini-3.8-flash --effort high`);
    assert.equal(bare.status, 0, 'no Track line is not owed');
    assert.equal(context(bare), '');
    assert.equal(run(`# Track: w1 ← rà [a.py]\norca orchestration worker-start ${spec} --agent antigravity --model gemini-3.8-flash`).status, 2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('turn-guard: a reply asking two things is sent back once', () => {
  const { manyAsks } = require('../claude/hooks/turn-guard.cjs');
  assert.equal(manyAsks('**Cần bạn:** đồng ý merge !67 không?'), null);
  assert.match(manyAsks('**Cần bạn:** merge !67?\n\n**Cần bạn:** báo khách?'), /2 `\*\*Cần bạn:\*\*` lines/);
  assert.match(manyAsks('**Cần bạn:**\n- merge !67\n- báo 2 khách nhận thư trùng'), /2 items/);
  assert.match(manyAsks('**Cần bạn:** merge !67 không? Có báo khách không?'), /2 questions/);
  assert.equal(manyAsks('**Cần bạn:** đồng ý không?\n\nGhi chú: vì sao? chưa rõ?'), null, 'text after the block does not count');
  assert.equal(manyAsks('```\n**Cần bạn:** a?\n```\n**Cần bạn:** chạy `a?b` không?'), null, 'code never counts');
  const stop = (active) => hook('turn-guard.cjs', { hook_event_name: 'Stop', stop_hook_active: active,
    last_assistant_message: 'Đã xong.\n\n**Cần bạn:** merge !67?\n**Cần bạn:** báo khách?' });
  assert.equal(stop(false).status, 2);
  assert.equal(stop(true).status, 0, 'never twice in a row');
});

test('worker-start-receipt: each new dispatch gets its stall watch, ready to run', () => {
  const { watchLines } = require('../claude/hooks/worker-start-receipt.cjs');
  const [line] = watchLines(['ctx_0123abcd']);
  assert.match(line, /worker-stall\.sh --dispatch ctx_0123abcd/);
  assert.match(line, /--ok done --wait running/);
  assert.match(line, /--why-wait/);
});
