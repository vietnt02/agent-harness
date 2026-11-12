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

test('rules-budget after Bash: a rule file over budget gets no nudge; CI holds those budgets', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nudge-rb-'));
  try {
    fs.mkdirSync(path.join(home, '.claude', 'rules', 'mine'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'CLAUDE.md'), 'x'.repeat(20000));
    const res = hook('rules-budget.cjs', { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, session_id: sid('rb') }, home);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout.trim(), '');
    // What it still guards: a session note's sections (rules/agent-harness/session-notes.md).
    const note = path.join(home, '.claude', 'session-notes', 'slug', 'n.md');
    fs.mkdirSync(path.dirname(note), { recursive: true });
    const write = (content) => hook('rules-budget.cjs', { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: note, content } }, home);
    const head = '---\nsession: s\nstatus: open\nscope: x\n---\n\n';
    const ok = write(`${head}## Đang làm\n\n- a\n\n## Resume\n\n- b\n`);
    assert.equal(ok.status, 0, ok.stderr);
    const stray = write(`${head}## Đang làm\n\n- a\n\n## Lịch sử\n\n- b\n`);
    assert.equal(stray.status, 0, 'a cap is a reminder, the write runs');
    assert.match(context(stray), /## Lịch sử/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});



test('main-checkout-guard: a git write into the main checkout is said once; turning hooks off is always blocked', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nudge-mcg-'));
  try {
    execFileSync('git', ['init', '-q', dir]);
    const s = sid('mcg');
    const run = (command) => hook('main-checkout-guard.cjs', { session_id: s, cwd: dir, tool_name: 'Bash', tool_input: { command } });
    const first = run('git checkout -b feat');
    assert.equal(first.status, 2);
    assert.match(first.stderr, /worktree/);
    assert.equal(run('git checkout -b feat').status, 0, 'said once: the same command again passes');
    assert.equal(run("ssh web1 'sudo systemctl restart nginx'").status, 0, 'a remote write needs no Gate line any more');
    const off = 'git -c core.hooksPath=/dev/null commit -m x';
    assert.equal(run(off).status, 2);
    assert.equal(run(off).status, 2, 'bypassing a check stays blocked');
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
  const lock = { command: 'npm test', timeout: 300000 };
  assert.equal(run(lock).status, 2);
  assert.equal(run(lock).status, 2, 'a foreground lock stays blocked');
});

test('watch-guard: only a loop of this shell around remote calls is one; scripts and text are not (kaizen fixtures)', () => {
  const s = sid('wg-remote');
  const run = (input) => hook('watch-guard.cjs', { session_id: s, cwd: os.tmpdir(), tool_name: 'Bash', tool_input: input });
  for (const command of [
    "ssh -o ConnectTimeout=10 host 'R=x; for f in $(sudo -n find /srv -name \"*.log\"); do wc -l $f; done'",
    "ssh vps 'for d in a b; do docker exec sched airflow dags list-runs $d -o json | python3 -c 1; done'",
    "cat > /tmp/k.md <<'EOF'\nfor h in a b; do ssh $h uptime; done\nEOF",
    "cat >/tmp/k.md <<'EOF'\nx\nEOF\ncat > /tmp/l.md <<'EOF'\nfor h in a; do docker exec c airflow dags trigger d; done\nEOF",
    `python3 -c 'print(1)' "for h in a; do ssh $h x; done"`,
  ]) assert.equal(run({ command, timeout: 110000 }).status, 0, command);
  const local = { command: 'for h in a b; do ssh $h uptime; done' };
  assert.equal(run(local).status, 2, 'a local loop of remote calls is held once');
  assert.equal(run(local).status, 0, 'and passes the second time');
});

test('watch-guard: a background watcher whose checkpoint outlives the Bash timeout is told the timeout it needs', () => {
  const s = sid('wg-cp');
  const run = (input) => hook('watch-guard.cjs', { session_id: s, cwd: os.tmpdir(), tool_name: 'Bash', tool_input: input });
  const w = '~/.claude/scripts/watch.sh --check "x" --ok done --wait running --deadline 3h --every 120 --checkpoint 3000';
  const short = run({ command: w, run_in_background: true });
  assert.equal(short.status, 2);
  assert.match(short.stderr, /timeout: 3300000/);
  assert.equal(run({ command: w, run_in_background: true, timeout: 3300000 }).status, 0);
  assert.equal(run({ command: w.replace(' --checkpoint 3000', ''), run_in_background: true }).status, 0, 'the default checkpoint fits');
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
    const noEffort = `# Track: w1 ← rà [a.py]\norca orchestration worker-start ${spec} --agent antigravity --model gemini-3.8-flash`;
    assert.equal(run(noEffort).status, 2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('dispatch-split-guard: a codex worker needs no ritual line; a full claude id is said once', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nudge-dsg-'));
  try {
    const transcript = transcriptWith(dir, 'giao worker đi');
    const session = sid('dsg-once');
    const run = (command) => hook('dispatch-split-guard.cjs', { session_id: session, transcript_path: transcript, cwd: dir,
      tool_name: 'Bash', tool_input: { command } });
    const spec = '--spec "Rà; chạy orca orchestration check --peek sau mỗi 10 lệnh"';
    assert.equal(run(`orca orchestration worker-start ${spec} --agent codex --model gpt-luna`).status, 0);
    const full = `orca orchestration worker-start ${spec} --agent claude --model claude-opus-5-5`;
    const first = run(full);
    assert.equal(first.status, 2);
    assert.match(first.stderr, /bare alias/);
    assert.equal(run(full).status, 0, 'the agent judged it and ran it again');
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

test('worker-stall: a worker waiting on its ask is running, not stale; a reply ends the wait', () => {
  const w = require('../claude/scripts/worker-stall.cjs');
  const o = { dispatch: 'ctx_a', idle: 10, errors: 3 };
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'nudge-ask-'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nudge-ws-'));
  // Shapes copied from an agy worker's transcript (worker-read --source transcript): the ask is sent
  // through a shell tool, and the coordinator's reply arrives as a user message.
  const asked = { role: 'assistant', timestamp: Date.now(), blocks: [{ type: 'tool-call', name: 'execute', input: { command: "python3 << 'PYEOF'\n…" } },
    { type: 'tool-result', output: 'STDOUT: Question msg_cb35a07c0e9b sent. Next: End your turn; Orca wakes you with the answer.\n\nSTDERR: \n\nEXIT: 0' }] };
  const said = { role: 'assistant', blocks: [{ type: 'text', text: 'Đã gửi kế hoạch, chờ coordinator duyệt.' }] };
  const reply = { role: 'user', blocks: [{ type: 'text', text: '──── From: RUN:RUN_1 (status) ──── Subject: Re: Question Duyệt kế hoạch' }] };
  const page = (messages) => () => ({ result: { transcript: { messages, limited: false, nextCursor: 'c' } } });
  try {
    const later = Date.now() + 11 * 60000;
    const deps = (msgs) => ({ show: () => ({ state: 'ready', workspace: `id::${dir}` }), now: later,
      newErrors: (d) => w.newErrors(d, page(msgs), state), waitingAsk: (d) => w.waitingAsk(d, state) });
    assert.match(w.status(o, deps([asked, said])), /^running waiting-coordinator 1\dm state=ready$/);
    assert.match(w.status(o, deps([])), /^running waiting-coordinator/, 'still waiting on the next run');
    assert.match(w.status(o, { ...deps([]), now: Date.now() + 61 * 60000 }), /^stale ask-unanswered>60m/, 'a wait has a ceiling');
    assert.throws(() => w.status(o, { ...deps([]), show: () => ({ state: 'ready', workspace: 'id::/no/such/dir' }) }), /no worktree/);
    assert.match(w.status(o, deps([reply])), /^stale idle>10m/, 'the reply ends the wait');
  } finally {
    fs.rmSync(state, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
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
    // First run: the worker writes between pages, so Orca rejects the cursor it just issued; the run
    // restarts once and counts from zero. The last page stays `limited` (clipped text), empty.
    const fresh = path.join(dir, 'fresh');
    asked.length = 0;
    let moved = false;
    const midRun = (a) => {
      const c = a.includes('--cursor') ? a[a.indexOf('--cursor') + 1] : '-';
      asked.push(c);
      if (c === 'c1' && !moved) { moved = true; throw Object.assign(new Error('Command failed'), { stderr: 'source_changed' }); }
      if (c === '-') return pages[0];
      if (c === 'c1') return page([], true, 'c2');
      return page([], true, c);
    };
    assert.equal(w.newErrors('ctx_f', midRun, fresh), 1, 'a first run counts its history once');
    assert.deepEqual(asked, ['-', 'c1', '-', 'c1'], 'restarts once, then stops at the empty page');
    assert.equal(JSON.parse(fs.readFileSync(path.join(fresh, 'ctx_f.json'), 'utf8')).cursor, 'c2', 'a first run saves where it ended');
    const err = (stderr) => Object.assign(new Error('Command failed'), { stderr });
    const cur = (a) => (a.includes('--cursor') ? a[a.indexOf('--cursor') + 1] : '-');
    const three = page([1, 2, 3].map(() => ({ role: 'assistant', blocks: [{ type: 'text', text: 'HTTP 429' }] })), true, 's1');
    // From a saved cursor, errors counted before a rejection are kept.
    fs.writeFileSync(path.join(fresh, 'ctx_k.json'), JSON.stringify({ cursor: 's0' }));
    assert.equal(w.newErrors('ctx_k', (a) => { const c = cur(a); if (c === 's0') return three; if (c === 's1') throw err('source_changed'); return page([], false, 'e'); }, fresh), 3);
    // A page that keeps the cursor it was sent is the end, messages or not.
    let calls = 0;
    w.newErrors('ctx_m', (a) => { calls++; return page([{ role: 'assistant', blocks: [{ type: 'text', text: 'ok' }] }], true, cur(a) === '-' ? 'm1' : 'm1'); }, fresh);
    assert.equal(calls, 2, 'stops when the cursor does not move');
    // Any other error, with or without a cursor, still stops the run.
    assert.throws(() => w.newErrors('ctx_g', () => { throw err('boom'); }, fresh), /Command failed/);
    assert.throws(() => w.newErrors('ctx_h', (a) => { if (cur(a) === '-') return three; throw err('boom'); }, fresh), /Command failed/);
    // A second rejection ends the run with what it counted instead of an error.
    assert.equal(w.newErrors('ctx_r', (a) => { if (cur(a) === '-') return three; throw err('source_changed'); }, path.join(dir, 'r')), 3);
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


test('worker-stall: an agy worker run in a terminal has no transcript; the age of its last conversation step shows instead of an error', () => {
  const w = require('../claude/scripts/worker-stall.cjs');
  const { DatabaseSync } = require('node:sqlite');
  const o = { dispatch: 'ctx_t', idle: 10, errors: 3 };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nudge-agy-'));
  const ws = path.join(root, 'repo-task');
  const convs = path.join(root, 'conversations');
  fs.mkdirSync(ws);
  fs.mkdirSync(convs);
  // The tables and the metadata bytes copy an agy CLI conversation DB: the worktree path sits in
  // `trajectory_metadata_blob`, followed by a protobuf length byte or a `file://` copy of itself.
  const conv = (name, workspace, mtimeMs) => {
    const p = path.join(convs, `${name}.db`);
    const db = new DatabaseSync(p);
    db.exec('CREATE TABLE trajectory_metadata_blob (id text DEFAULT "main", data blob, PRIMARY KEY (id))');
    db.prepare('INSERT INTO trajectory_metadata_blob (data) VALUES (?)').run(Buffer.from(`\n\x12${workspace}\x12Tfile://${workspace}\x1a`));
    db.close();
    fs.utimesSync(p, mtimeMs / 1000, mtimeMs / 1000);
  };
  // What Orca prints for such a dispatch (worker-stall's stderr, copied from a real run).
  const noTranscript = () => { throw Object.assign(new Error('Command failed'), { stderr: 'transcript_required: Structured output is unavailable for Dispatch ctx_t: provider_unsupported.' }); };
  try {
    // Whole seconds: a file time set from a fraction comes back a hair earlier, which tips the exact --idle-min case.
    const now = Math.ceil((Date.now() + 11 * 60000) / 1000) * 1000;
    const deps = { show: () => ({ state: 'running', workspace: `id::${ws}` }), newErrors: noTranscript, now,
      agyLastStep: (p) => w.agyLastStep(p, convs) };
    assert.match(w.status(o, deps), /^stale idle>10m agy-step=none state=running$/, 'no conversation found: still a state line, never an error');
    conv('mine', ws, now - 2 * 60000);
    conv('sibling', `${ws}-2`, now - 60000);
    // A worker that plans before it edits changes no file for a while; a step of its own within
    // --idle-min still means running, whatever the worktree's file times say.
    assert.match(w.status(o, deps), /^running agy-step=2m state=running$/, 'the newer DB of `<worktree>-2` is another worker');
    assert.match(w.status(o, { ...deps, now: now + 8 * 60000 }), /^running agy-step=10m state=running$/, 'a step exactly --idle-min ago counts, as a file changed then does');
    assert.match(w.status(o, { ...deps, now: now + 8 * 60000 + 1000 }), /^stale idle>10m agy-step=10m state=running$/, 'no file and no step within --idle-min');
    assert.match(w.status(o, { ...deps, newErrors: () => 0 }), /^stale idle>10m state=running$/, 'a worker with a transcript is judged by its files, never by an agy DB');
    fs.writeFileSync(path.join(ws, 'a.txt'), 'x');
    assert.match(w.status(o, { ...deps, now: Date.now() }), /^running changed=a\.txt agy-step=0m state=running$/);
    assert.throws(() => w.status(o, { ...deps, newErrors: () => { throw Object.assign(new Error('Command failed: dispatch_not_found'), { stderr: 'dispatch_not_found' }); } }), /dispatch_not_found/, 'any other read error still fails');
    assert.match(w.status(o, { ...deps, newErrors: () => 0, now: Date.now() }), /^running changed=a\.txt state=running$/, 'a worker with a transcript keeps its line');
    // agy keeps its DB in WAL mode. Closed by agy, a DB has no -wal; any reader's open then leaves an
    // empty -wal stamped with the read time, which is no step. While agy holds it open, the -wal has
    // the latest steps and its time is the last step.
    const walDb = (name, workspace) => {
      const p = path.join(convs, `${name}.db`);
      const db = new DatabaseSync(p);
      db.exec('PRAGMA journal_mode=WAL; CREATE TABLE trajectory_metadata_blob (id text DEFAULT "main", data blob, PRIMARY KEY (id))');
      db.prepare('INSERT INTO trajectory_metadata_blob (data) VALUES (?)').run(Buffer.from(`\n\x12${workspace}\x12`));
      return { p, db };
    };
    const ws2 = path.join(root, 'repo-closed');
    fs.mkdirSync(ws2);
    const closed = walDb('closed', ws2);
    closed.db.close();
    const t = Date.now() + 5 * 60000;
    fs.utimesSync(closed.p, t / 1000, t / 1000);
    const at = Date.now() + 65 * 60000;
    const deps2 = { ...deps, show: () => ({ state: 'running', workspace: `id::${ws2}` }), now: at };
    assert.match(w.status(o, deps2), / agy-step=60m /);
    assert.ok(fs.existsSync(`${closed.p}-wal`) && fs.statSync(`${closed.p}-wal`).size === 0, 'the first read left an empty -wal');
    fs.utimesSync(`${closed.p}-wal`, (at - 60000) / 1000, (at - 60000) / 1000); // as if a reader opened it a minute ago
    assert.match(w.status(o, deps2), / agy-step=60m /, 'the empty -wal it left is no step');
    const ws3 = path.join(root, 'repo-open');
    fs.mkdirSync(ws3);
    const open = walDb('open', ws3);
    try {
      const tw = at - 2.5 * 60000;
      assert.ok(fs.statSync(`${open.p}-wal`).size > 0, 'agy holding the DB open keeps steps in -wal');
      fs.utimesSync(`${open.p}-wal`, tw / 1000, tw / 1000);
      fs.utimesSync(open.p, t / 1000, t / 1000);
      assert.match(w.status(o, { ...deps, show: () => ({ state: 'running', workspace: `id::${ws3}` }), now: at }), / agy-step=2m /);
    } finally { open.db.close(); }
    // A DB last written before the worktree existed is another, older worker's: the scan stops there.
    const ws4 = path.join(root, 'repo-new');
    fs.mkdirSync(ws4);
    if (fs.statSync(ws4).birthtimeMs > 0) {
      conv('older', ws4, fs.statSync(ws4).birthtimeMs - 60000);
      assert.match(w.status(o, { ...deps, show: () => ({ state: 'running', workspace: `id::${ws4}` }) }), / agy-step=none /);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
