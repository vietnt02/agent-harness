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
    const ran = (i) => hook('coordinator-read-guard.cjs', { ...base, hook_event_name: 'PostToolUse', tool_name: 'Read',
      tool_use_id: `tu_${i}`, tool_input: { file_path: path.join(watched, `f${i}`) } }, home);
    for (const i of [1, 2]) {
      const r = read(i);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(context(r), '', `read ${i} is quiet`);
      ran(i); // counted, not left to a pending mark's clock
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

test('gate-line-guard: a remote write with no Gate line stays blocked, rerun or not', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nudge-glg-'));
  try {
    const transcript = transcriptWith(dir);
    const s = sid('glg');
    const run = (command) => hook('gate-line-guard.cjs', { session_id: s, transcript_path: transcript, cwd: dir,
      tool_name: 'Bash', tool_input: { command } });
    const write = "ssh web1 'sudo systemctl restart nginx'";
    assert.equal(run(write).status, 2);
    assert.equal(run(write).status, 2, 'it cannot be undone: a rerun is still blocked');
    assert.equal(run(`# Gate: mở bởi "khởi động lại nginx" → khối web1\n${write}`).status, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('watch-guard: an unwatched loop is held once; a session lock is always blocked', () => {
  const s = sid('wg');
  const run = (input) => hook('watch-guard.cjs', { session_id: s, cwd: os.tmpdir(), tool_name: 'Bash', tool_input: input });
  const loop = { command: 'while true; do ls; sleep 5; done', run_in_background: true };
  assert.equal(run(loop).status, 2);
  assert.equal(run(loop).status, 0, 'the same loop again passes');
  const msg = { command: "git commit -F - <<'EOF'\nfix: while waiting do not sleep\nEOF" };
  assert.equal(run(msg).status, 0, 'loop words in a commit message are text, not a poll');
  const py = { command: "python3 - <<'EOF'\nwhile x:\n    do(); ssh(); sleep(1)\nEOF" };
  assert.equal(run(py).status, 0, 'a Python heredoc is text');
  for (const runner of ['bash', 'ssh web1', 'sudo -u app -s']) {
    const loop = { command: `${runner} <<'EOF'\nwhile true; do uptime; sleep 5; done\nEOF`, run_in_background: true };
    assert.equal(run(loop).status, 2, `${runner} runs its heredoc: still read`);
  }
  const remote = { command: "ssh web1 <<'EOF'\nwhile true; do uptime; sleep 5; done\nEOF" };
  assert.equal(run(remote).status, 2, 'a foreground remote poll locks the session');
  assert.equal(run(remote).status, 2, 'and stays blocked');
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
  assert.equal(manyAsks('**Cần bạn:** cho phép lệnh `git push origin x` không?\n- rule: Protected Branch Push\n- file: ~/.claude/settings.json\n- tác động: push lên nhánh x'), null, 'the ask to allow a blocked command lists its parts');
  assert.equal(manyAsks('**Cần bạn:** chọn một:\n1. merge ngay\n2. chờ CI xanh rồi merge'), null, 'a closed choice lists its options');
  assert.equal(manyAsks('**Cần bạn:** mở https://example.com/a?b=1 rồi duyệt không?'), null, 'a URL query is no question');
  assert.match(manyAsks('**Cần bạn:** merge [#21](https://github.com/o/r/pull/21)? Và báo khách không?'), /2 questions/, 'a ? after a link counts');
  assert.equal(manyAsks('**Cần bạn:** chọn một:\n1. merge ngay?\n2. chờ CI xanh rồi merge?'), null, 'options ending in ? are one choice');
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
  assert.match(line, /node ~\/\.claude\/scripts\/worker-stall\.cjs --dispatch ctx_0123abcd/);
  assert.match(line, /--ok done --wait running/);
  assert.match(line, /--why-wait/);
  assert.match(line, /--checkpoint 3000/, 'one wake-up per 50 minutes at most, not every 10');
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'claude', 'scripts', 'worker-stall.cjs')), 'the script it names ships');
});

test('worker-stall: a stopped worker is done; errors count only in new worker messages; no worktree is an error', () => {
  const w = require('../claude/scripts/worker-stall.cjs');
  const o = { dispatch: 'ctx_t', idle: 10, errors: 3 };
  assert.equal(w.status(o, { show: () => ({ state: 'stopped' }) }), 'done stopped');
  assert.throws(() => w.status(o, { show: () => ({ state: 'running', workspace: 'id::/no/such/dir' }), newErrors: () => 0 }), /no worktree/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nudge-ws-'));
  try {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'x');
    const deps = { show: () => ({ state: 'running', workspace: `id::${dir}` }), newErrors: () => 0 };
    assert.match(w.status(o, deps), /^running changed=a\.txt/);
    const later = Date.now() + 11 * 60000;
    assert.match(w.status(o, { ...deps, now: later }), /^stale idle>10m/);
    assert.match(w.status(o, { ...deps, newErrors: () => 3 }), /^stale api-errors=3/);
    const page = (messages, limited, cursor) => ({ result: { transcript: { messages, limited, nextCursor: cursor }, cursor } });
    const pages = [
      page([{ role: 'user', blocks: [{ type: 'text', text: 'retry on 429 Too Many Requests' }] },
        { role: 'assistant', blocks: [{ type: 'text', text: 'Error: 502 Bad Gateway' }] }], true, 'c1'),
      page([{ role: 'assistant', blocks: [{ type: 'tool-result', output: 'HTTP 503' }] },
        { role: 'assistant', blocks: [{ type: 'text', text: 'edited lines 429-430' }] }], false, 'c2'),
    ];
    const asked = [];
    const read = (a) => { asked.push(a.includes('--cursor') ? a[a.indexOf('--cursor') + 1] : '-'); return pages[asked.length - 1] || page([], false, 'c2'); };
    const state = path.join(dir, 'state');
    assert.equal(w.newErrors('ctx_t', read, state), 2, 'the brief and a line number never count');
    assert.deepEqual(asked, ['-', 'c1']);
    asked.length = 0;
    assert.equal(w.newErrors('ctx_t', (a) => { asked.push(a[a.indexOf('--cursor') + 1]); return page([], false, 'c2'); }, state), 0);
    assert.deepEqual(asked, ['c2'], 'the next run starts where the last one ended');
    asked.length = 0;
    const rejectSaved = (a) => {
      const c = a.includes('--cursor') ? a[a.indexOf('--cursor') + 1] : '-';
      asked.push(c);
      if (c === 'c2') throw Object.assign(new Error('Command failed'), { stderr: 'source_changed' });
      return pages[0].result.transcript.nextCursor === c ? pages[1] : pages[0];
    };
    assert.equal(w.newErrors('ctx_t', rejectSaved, state), 0, 'a rejected cursor resets without counting old history');
    assert.deepEqual(asked, ['c2', '-', 'c1']);
    assert.equal(JSON.parse(fs.readFileSync(path.join(state, 'ctx_t.json'), 'utf8')).cursor, 'c2', 'and the cursor is at the end again');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('worker-start-receipt: a new agy version runs the fixtures and speaks only on a fail', () => {
  const { agyVersionLines } = require('../claude/hooks/worker-start-receipt.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nudge-agy-'));
  try {
    const stamp = path.join(dir, 'tested-versions.json');
    fs.writeFileSync(stamp, JSON.stringify({ cli: '1.0.0', runtimes: [] }));
    const runner = (code, out = '') => fs.writeFileSync(path.join(dir, 'run.cjs'), `process.stdout.write(${JSON.stringify(out)}); process.exit(${code});`);
    const lines = () => agyVersionLines(stamp, path.join(dir, 'no-runtimes'), '1.0.1');
    runner(0);
    assert.deepEqual(lines(), [], 'green: the runner recorded the version, nothing to say');
    runner(3, 'WAIT  no agy payload seen\n');
    assert.deepEqual(lines(), [], 'no payload of the new version yet: quiet, a later dispatch checks again');
    runner(1, 'FAIL  the installed agy sent payload shapes payloads.json does not replay:\n  a,b|c\n');
    const [msg] = lines();
    assert.match(msg, /fixture bridge FAIL/);
    assert.match(msg, /a,b\|c/);
    assert.deepEqual(agyVersionLines(stamp, path.join(dir, 'no-runtimes'), '1.0.0'), [], 'same version: the runner is not run');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('note-recall: only what the note holds in force stops a command; IDs and next steps never do', () => {
  const { recall } = require('../claude/hooks/note-recall.cjs');
  const body = [
    '## Đang làm', 'PR #21: chờ CI rồi merge nhánh kaizen/harness-nhac-nhe', '',
    '## Đang có hiệu lực', '- "chỉ push kaizen/harness-nhac-nhe, chưa merge" (uuid u1)', '',
    '## Đã xong', '- vietnt02/agent-harness#19 merged', '',
    '## Resume', '- vietnt02/agent-harness#21, nhánh kaizen/harness-nhac-nhe',
  ].join('\n');
  const hits = recall([{ file: 'n.md', body }], 'git push origin kaizen/harness-nhac-nhe');
  assert.deepEqual(hits.map((h) => h.line), ['- "chỉ push kaizen/harness-nhac-nhe, chưa merge" (uuid u1)']);
  assert.deepEqual(recall([{ file: 'n.md', body: body.replace(/^## Đang có hiệu lực\n.*\n/m, '') }],
    'gh pr checks 21 --repo vietnt02/agent-harness'), [], 'Resume and Đã xong IDs never stop a command');
  assert.equal(recall([{ file: 'old.md', body: '- dùng nhánh kaizen/harness-nhac-nhe' }], 'git push origin kaizen/harness-nhac-nhe').length, 1,
    'a note with no sections is read whole');
  const push = 'git push origin kaizen/harness-nhac-nhe';
  assert.equal(recall([{ file: 'nfd.md', body: body.normalize('NFD') }], push).length, 1, 'an NFD note still finds its in-force section');
  assert.equal(recall([{ file: 'crlf.md', body: body.replace(/\n/g, '\r\n') }], push).length, 1, 'CRLF too');
  const fenced = body.replace('- "chỉ push', '```\n## not a heading\n```\n- "chỉ push');
  assert.equal(recall([{ file: 'f.md', body: fenced }], push).length, 1, 'a ## inside a fence ends no section');
  const older = '- Viet: "dùng kaizen/harness-nhac-nhe"\n## Quyết định của Viet\n- push kaizen/harness-nhac-nhe trước\n## Trạng thái resume\n- x';
  assert.equal(recall([{ file: 'o.md', body: older }], push).length, 2, 'an older layout without the in-force section is read whole');
});
