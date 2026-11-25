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
    'ssh vps cat /srv/x.log > /tmp/L; for o in 101 102 103; do grep -c $o /tmp/L; done',
    "glab mr update 590 --ready | tail -1 && glab api -X POST projects/a/merge_requests/590/pipelines | jq -r .id; for d in ctx_1 ctx_2; do orca orchestration worker-release --dispatch $d | tail -1; done",
  ]) assert.equal(run({ command, timeout: 110000 }).status, 0, command);
  const local = { command: 'for h in $(cat hosts); do ssh $h uptime; done' };
  assert.equal(run(local).status, 2, 'a local loop of remote calls over a list known only when it runs is held once');
  assert.equal(run(local).status, 0, 'and passes the second time');
});

test('watch-guard: a background `while read` over input and a foreground `for` over a few listed items pass; a wait or an open list is held (kaizen fixtures)', () => {
  const s = sid('wg-listed');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-'));
  const run = (input) => hook('watch-guard.cjs', { session_id: s, cwd: dir, tool_name: 'Bash', tool_input: input });
  try {
    // The loops of a worktree setup script: walk a file list, no `sleep`, no remote call.
    fs.writeFileSync(path.join(dir, 'setup.sh'), "while IFS= read -r -d '' rel; do ln -sfn \"$rel\" x; done < <(git ls-files -z)\n" +
      'while IFS= read -r lock; do npm ci; done < locks\n');
    assert.equal(run({ command: 'bash setup.sh > setup.log 2>&1', run_in_background: true }).status, 0, 'a script reading its input waits on nothing');
    assert.equal(run({ command: 'for n in 1 2 3; do glab api x/$n; done' }).status, 0, 'three listed reads');
    assert.equal(run({ command: 'for p in 11 12; do glab api projects/a/pipelines/$p/jobs; done' }).status, 0, 'two listed reads');
    for (const [command, why] of [
      ['for id in $(glab api y); do glab api x/$id; done', 'a list known only when it runs'],
      ['for n in 1 2 3; do glab api x/$n; sleep 5; done', 'listed, but it sleeps'],
      ['for n in 1 2 3 4 5 6; do glab api x/$n; done', 'more than five items'],
    ]) assert.equal(run({ command }).status, 2, why);
    assert.equal(run({ command: 'while ! curl -s x; do sleep 5; done', run_in_background: true }).status, 2, 'a background poll still goes through watch.sh');
    assert.equal(run({ command: 'while true; do gh api x; done', run_in_background: true }).status, 2, 'a background loop calling out each round');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
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

test('turn-guard: a leftover the user settled in an AskUserQuestion this turn is not sent back', () => {
  const stop = (active, msg, transcript) => hook('turn-guard.cjs', { hook_event_name: 'Stop', stop_hook_active: active, last_assistant_message: msg, transcript_path: transcript });
  assert.equal(stop(false, '# Xong\n\nĐã sửa.\n\n**Cần bạn:** đồng ý merge !67 không?').status, 0, 'a question in text is left to the rule');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-'));
  try {
    const t = path.join(dir, 't.jsonl');
    const rec = (o) => JSON.stringify(o);
    const leftover = '# Xong\n\nĐã merge !12 và deploy.\n\nDoc runbook còn lệch với lệnh deploy mới; bạn đã chọn để Claude sửa ở lượt sau.';
    fs.writeFileSync(t, [rec({ type: 'user', message: { content: 'merge đi' } }),
      rec({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'a', name: 'AskUserQuestion', input: {} }] } }),
      rec({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a', content: 'Your questions have been answered: "x"="sửa sau". You can now continue with these answers in mind.' }] } })].join('\n'));
    assert.equal(stop(false, leftover, t).status, 0, 'the ask settled it');
    fs.writeFileSync(t, [rec({ type: 'user', message: { content: 'merge đi' } }),
      rec({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a', content: 'The user answered: "x"="sửa sau". Read the answers carefully.' }] } })].join('\n'));
    assert.equal(stop(false, leftover, t).status, 0, 'the other answer shape settles it too');
    fs.writeFileSync(t, rec({ type: 'user', message: { content: 'merge đi' } }));
    assert.equal(stop(false, leftover, t).status, 2, 'no ask this turn: sent back');
    assert.equal(stop(true, leftover, t).status, 0, 'never twice in a row');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('answer-first: a mid-turn question is answered now and again in the last text', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-'));
  try {
    const t = path.join(dir, 't.jsonl');
    fs.writeFileSync(t, [JSON.stringify({ type: 'user', message: { content: 'làm plan đi' } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'a', name: 'Bash', input: {} }] } }),
      JSON.stringify({ type: 'attachment', attachment: { type: 'queued_command', prompt: 'sao không hỏi tôi triển khai luôn không?', origin: { kind: 'human' } } })].join('\n'));
    const out = JSON.parse(hook('answer-first.cjs', { hook_event_name: 'PreToolUse', transcript_path: t }).stdout);
    assert.match(out.hookSpecificOutput.additionalContext, /Answer it now in one line, and again in the turn's last text/);
    assert.match(out.hookSpecificOutput.additionalContext, /just before the AskUserQuestion/, 'the report goes as text before the ask (communication-style.md)');
    assert.doesNotMatch(out.hookSpecificOutput.additionalContext, /inside the AskUserQuestion/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('worker-start-receipt: each new dispatch gets its stall watch, ready to run', () => {
  const { watchLines } = require('../claude/hooks/worker-start-receipt.cjs');
  const [line] = watchLines(['ctx_0123abcd']);
  assert.match(line, /node ~\/\.claude\/scripts\/worker-stall\.cjs --dispatch ctx_0123abcd/);
  assert.match(line, /--ok done --wait running/);
  assert.match(line, /--why-wait/);
  assert.match(line, /--checkpoint 3000/, 'one wake-up per 50 minutes at most, not every 10');
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'claude', 'scripts', 'worker-stall.cjs')), 'the script it names ships');
  const { launchArgs } = require('../claude/hooks/worker-start-receipt.cjs');
  const agy = launchArgs('orca orchestration worker-start --agent antigravity --model gemini-4-neon --effort high --spec-file s.md');
  assert.match(watchLines(['ctx_0123abcd'], agy)[0], /worker-stall\.cjs --dispatch ctx_0123abcd --model gemini-4-neon --effort high"/);
  assert.equal(launchArgs('orca orchestration worker-start --agent codex --model gpt-sol'), '', 'only agy prints the Gemini banner');
});

test('worker-stall: an agy worker whose banner shows another model than the one given ends the watch; a match is read once', () => {
  const w = require('../claude/scripts/worker-stall.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nudge-model-'));
  try {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'x');
    const show = () => ({ state: 'ready', workspace: `id::${dir}`, terminal: 'term_b471' });
    const base = { show, newErrors: () => 0, stateDir: path.join(dir, 'state') };
    const o = { dispatch: 'ctx_fccb', idle: 10, errors: 3, model: 'gemini-4-neon', effort: 'high' };
    // The banner a reopened fix worker showed (launched without --model).
    const hydro = '... Gemini 4 Hydrogen (High) ... Conversation compacted';
    assert.equal(w.status(o, { ...base, readTerminal: () => hydro }), 'model-mismatch want=gemini-4-neon high got="Gemini 4 Hydrogen (High)" state=ready');
    assert.match(w.status(o, { ...base, readTerminal: () => 'starting...' }), /^running/, 'no banner yet: judged on files as before');
    assert.match(w.status(o, { ...base, readTerminal: () => { throw new Error('gone'); } }), /^running/, 'unreadable terminal: no judgement');
    let reads = 0;
    const neon = () => { reads++; return 'Gemini 4 Neon (High)'; };
    assert.match(w.status(o, { ...base, readTerminal: neon }), /^running/);
    assert.match(w.status(o, { ...base, readTerminal: neon }), /^running/);
    assert.equal(reads, 1, 'a confirmed model is not read again');
    assert.match(w.status({ ...o, dispatch: 'ctx_x', model: '' }, { ...base, readTerminal: () => hydro }), /^running/, 'no --model: no check');
    assert.equal(w.status({ ...o, dispatch: 'ctx_y', effort: 'xhigh' }, { ...base, readTerminal: () => 'Gemini 4 Neon (High)' }).split(' ')[0], 'model-mismatch', 'the effort counts too');
    assert.equal(w.status({ ...o, dispatch: 'ctx_z', model: 'gemini-4-neon-xhigh', effort: '' }, { ...base, readTerminal: () => 'Gemini 4 Neon (High)' }).split(' ')[0], 'model-mismatch', 'the effort a slug carries counts');
    assert.match(w.status({ ...o, dispatch: 'ctx_q' }, { ...base, readTerminal: () => 'reading SKILL.md: banner `Gemini 4 Hydrogen (High)`\n...\nGemini 4 Neon (High)' }), /^running/, 'the last banner, not a quoted one');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
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
    // A worker's edit comes after the checkout that wrote the worktree's files at its birth.
    const edit = Date.now() + 2 * 60000;
    fs.writeFileSync(path.join(dir, 'a.txt'), 'x');
    fs.utimesSync(path.join(dir, 'a.txt'), new Date(edit), new Date(edit));
    const deps = { show: () => ({ state: 'running', workspace: `id::${dir}` }), newErrors: () => 0, now: edit + 1000 };
    assert.match(w.status(o, deps), /^running changed=a\.txt/);
    const later = edit + 11 * 60000;
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
    // The runner crashing (a bad JSON payload) is told apart from a guard that missed.
    fs.writeFileSync(path.join(dir, 'run.cjs'), 'JSON.parse(\'{"p":"C:\\\\Users\\\\x\\\\y"}\'.replace(/\\\\\\\\/g, "\\\\"));');
    const [crash] = lines();
    assert.doesNotMatch(crash, /fixture bridge FAIL/);
    assert.match(crash, /không chạy được.*SyntaxError/);
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
    fs.utimesSync(path.join(ws, 'a.txt'), new Date(now), new Date(now)); // an edit after the checkout
    assert.match(w.status(o, { ...deps, now: now + 1000 }), /^running changed=a\.txt agy-step=2m state=running$/);
    assert.throws(() => w.status(o, { ...deps, newErrors: () => { throw Object.assign(new Error('Command failed: dispatch_not_found'), { stderr: 'dispatch_not_found' }); } }), /dispatch_not_found/, 'any other read error still fails');
    assert.match(w.status(o, { ...deps, newErrors: () => 0, now: now + 1000 }), /^running changed=a\.txt state=running$/, 'a worker with a transcript keeps its line');
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

test('ask-batch-guard: an ask after an answered ask of the same block, tools between, is held once (kaizen fixtures)', () => {
  const { spacedAsk } = require('../claude/hooks/ask-batch-guard.cjs');
  const user = (content) => ({ type: 'user', message: { role: 'user', content } });
  const ask = (id) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'AskUserQuestion', input: {} }] } });
  const answer = (id) => user([{ type: 'tool_result', tool_use_id: id, content: 'Your questions have been answered: "x"="Đăng (Recommended)". You can now continue with these answers in mind.' }]);
  const tool = (id) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'gh pr comment' } }] } });
  const result = (id) => user([{ type: 'tool_result', tool_use_id: id, content: 'ok' }]);
  const done = user('──── From: TERM_781B (term_781b) (worker_done) ──── Subject: Review PR #488 xong');
  // The review block of three PRs: each reviewer's worker_done woke the coordinator, which asked again.
  const block = [user('check & review giúp tôi'), ask('a1'), answer('a1'), tool('t1'), result('t1'), done, tool('t2'), result('t2')];
  assert.equal(spacedAsk(block), 'a1', 'the second ask: a worker message is no user message');
  assert.equal(spacedAsk([...block, ask('a2'), answer('a2'), tool('t3'), result('t3'), done]), 'a2', 'the third ask too');
  assert.equal(spacedAsk([user('check & review giúp tôi'), tool('t1'), result('t1')]), null, 'the first ask of a block');
  assert.equal(spacedAsk([...block, user('ok, tiếp đi')]), null, 'right after the user types');
  assert.equal(spacedAsk([user('x'), ask('a1'), answer('a1')]), null, 'back to back: no tool between');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-batch-'));
  try {
    const t = path.join(dir, 't.jsonl');
    fs.writeFileSync(t, block.map((r) => JSON.stringify(r)).join('\n') + '\n');
    const call = { hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', session_id: `s-${process.pid}-${Date.now()}`, transcript_path: t, tool_input: { questions: [{ question: 'Đăng comment trả #489?' }] } };
    const held = hook('ask-batch-guard.cjs', call);
    assert.equal(held.status, 2);
    assert.match(held.stderr, /one ask a block.*last ask/);
    assert.equal(hook('ask-batch-guard.cjs', { ...call, tool_input: { questions: [{ question: 'Đăng comment trả #489?' }, { question: 'Đăng #488?' }] } }).status, 0,
      'said once per answered ask: the merged ask the note asks for passes');
    assert.equal(hook('ask-batch-guard.cjs', { ...call, tool_name: 'Bash' }).status, 0);
    // A long block: the answered ask sits more than the first read's 512 KB behind the end.
    const { spacedAskIn } = require('../claude/hooks/ask-batch-guard.cjs');
    const long = path.join(dir, 'long.jsonl');
    const big = result('t9'); big.message.content[0].content = 'x'.repeat(700 * 1024);
    fs.writeFileSync(long, [...block, tool('t9'), big].map((r) => JSON.stringify(r)).join('\n') + '\n');
    assert.equal(spacedAskIn(long), 'a1', 'read back past the tail');
    fs.writeFileSync(long, [user('x'), tool('t9'), big].map((r) => JSON.stringify(r)).join('\n') + '\n');
    assert.equal(spacedAskIn(long), null, 'no answered ask in the whole file');
    assert.equal(hook('ask-batch-guard.cjs', { ...call, transcript_path: path.join(dir, 'none.jsonl') }).status, 0, 'fails open');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('turn-guard: a Cần bạn step a tool reaches is sent back once; a step only the user can do is not (kaizen fixtures)', () => {
  const { doableStep } = require('../claude/hooks/turn-guard.cjs');
  // Lines of three real reports that handed the user steps Claude then did itself in a minute.
  assert.equal(doableStep('# Xong\n\n**Cần bạn:** mở POS shop 1942354734 và huỷ đơn 088f8m-0i-#1452 nếu chưa huỷ. Sau đó đóng issue [#486](https://github.com/o/r/issues/486).'), 'đóng issue');
  assert.equal(doableStep('**Cần bạn:** trả lời Tân về mục 4: !920 đã merge.'), 'trả lời Tân');
  assert.match(doableStep('**Cần bạn:**\n- comment lên mine_chapter#466 kết quả kiểm.'), /^comment lên mine_chapter#4/);
  assert.equal(doableStep('**Cần bạn:** kiểm đơn #1452 trên POS đã huỷ chưa.'), 'kiểm');
  // Steps no tool of the session reaches, and lines that are not a handoff.
  assert.equal(doableStep('**Cần bạn:** bấm huỷ đơn trên giao diện POS (không có API ghi).'), null);
  assert.equal(doableStep('**Cần bạn:** đăng nhập lại Lark bằng tài khoản công ty.'), null);
  assert.equal(doableStep('**Cần bạn:** báo lỗi cho bộ phận kho khi họ gửi lại file.'), null, 'no named person');
  assert.equal(doableStep('**Cần bạn:** đồng ý merge !67 không?'), null, 'a question in text is left to the rule');
  assert.equal(doableStep('**Claude đã làm:** đóng issue #486 và báo Tân.'), null);
  assert.equal(doableStep('**Cần bạn:** chọn người nhận, rồi Claude đóng issue `#486`.'), null, 'inline code cites');
  assert.equal(doableStep('**Cần bạn:** đăng nhập lại Lark bằng tài khoản công ty, rồi báo Claude.'), null, 'reporting back to Claude');
  assert.equal(doableStep('**Cần bạn:**\n- báo Claude khi xong'), null);
  assert.equal(doableStep('**Cần bạn:** trả lời AskUserQuestion bên dưới.'), null, 'the ask box is no person');
  assert.equal(doableStep('**Cần bạn:** gửi tin Zalo cho anh Dũng (Claude không có Zalo).'), null, 'a channel the session lacks');
  assert.equal(doableStep('**Cần bạn:** mở app trên điện thoại, kiểm thông báo đã tới chưa.'), null, 'a check on a device');
  assert.equal(doableStep('**Cần bạn:** quét mã QR trên điện thoại; xem màn hình có báo thành công.'), null);
  assert.equal(doableStep('**Cần bạn:** xem xét đề xuất và chọn A hoặc B.'), null, 'a decision, not a read');
  assert.equal(doableStep('**Cần bạn:** merge production branch trên giao diện Vercel (Claude không có quyền).'), null, '"pr" inside a word');
  assert.equal(doableStep('**Cần bạn:** báo anh Dũng rằng !920 đã merge.'), 'báo anh Dũng');
  const stop = (active, msg) => hook('turn-guard.cjs', { hook_event_name: 'Stop', stop_hook_active: active, last_assistant_message: msg });
  const sent = stop(false, '# Xong\n\nĐã review 3 PR.\n\n**Cần bạn:** đóng issue #486.');
  assert.equal(sent.status, 2);
  assert.match(sent.stderr, /step a tool of yours reaches \("đóng issue"\).*AskUserQuestion/);
  assert.equal(stop(true, '# Xong\n\n**Cần bạn:** đóng issue #486.').status, 0, 'once: the second stop goes through');
});

test('turn-guard: a step Claude says it takes is no leftover; one put off still is (kaizen fixtures)', () => {
  const { parkedProblem } = require('../claude/hooks/turn-guard.cjs');
  assert.equal(parkedProblem('Claude đã nhắn w11 và w12 dừng việc và gửi báo cáo phần đã làm được. Khi cả hai báo xong, ' +
    'hoặc hết 6 phút, Claude sẽ dừng hẳn hai worker, tắt server còn sót, gỡ các worktree sạch rồi gửi báo cáo cuối.'), null);
  assert.equal(parkedProblem('- Sẽ gỡ worktree còn sót sau khi worker release.'), null);
  assert.ok(parkedProblem('Còn sót 2 file chưa sửa.'));
  assert.ok(parkedProblem('Claude sẽ để phần còn sót cho phiên sau.'));
  assert.ok(parkedProblem('Bạn sẽ thấy còn sót 2 file.'), 'only Claude\'s own step is skipped');
  assert.ok(parkedProblem('Claude sẽ merge PR, còn sót 2 test lỗi chưa sửa.'), 'a leftover in its own clause');
  assert.ok(parkedProblem('Claude sẽ sửa phần còn sót ở PR sau.'), 'put off to a later PR');
  assert.ok(parkedProblem('Claude sẽ sửa phần còn sót vào ngày mai.'), 'put off to tomorrow');
});

test('watch-guard: a watcher reports at the sooner of its deadline and checkpoint, so a short deadline needs no long timeout (kaizen fixture)', () => {
  const s = sid('wg-dl');
  const run = (input) => hook('watch-guard.cjs', { session_id: s, cwd: os.tmpdir(), tool_name: 'Bash', tool_input: input });
  const w = '~/.claude/scripts/watch.sh --check "x" --ok done --wait running --deadline 6m --why-wait "w" --every 30 --checkpoint 3000';
  assert.equal(run({ command: w, run_in_background: true, timeout: 420000 }).status, 0);
  const short = run({ command: w, run_in_background: true, timeout: 300000 });
  assert.equal(short.status, 2);
  assert.match(short.stderr, /timeout: 660000/);
});

test('worker-stall: an idle worker names the process holding its worktree, never the agent or its shell (kaizen fixture)', () => {
  const w = require('../claude/scripts/worker-stall.cjs');
  const rows = [
    { pid: '10', etime: '40:00', args: '/opt/agy/bin/agy --model gemini-4-hydrogen' },
    { pid: '11', etime: '39:58', args: '-zsh' },
    { pid: '12', etime: '18:05', args: 'npm exec tsx scripts/sign.ts' },
    { pid: '13', etime: '02:00', args: 'node /x/node_modules/vite/bin/vite.js' },
  ];
  assert.equal(w.heldBy('/wt', () => rows), ' holding=npm 18m pid=12');
  // A Claude worker's MCP servers are its own children and run all session; a command goes through a shell.
  const claude = [
    { pid: '20', ppid: '1', etime: '40:00', args: '/opt/claude/bin/claude --output-format stream-json' },
    { pid: '21', ppid: '20', etime: '39:58', args: 'node /opt/mcp/image-analysis-server.cjs' },
    { pid: '22', ppid: '20', etime: '39:50', args: '/bin/zsh -c npm exec tsx scripts/sign.ts' },
    { pid: '23', ppid: '22', etime: '18:05', args: 'npm exec tsx scripts/sign.ts' },
  ];
  assert.equal(w.heldBy('/wt', () => claude), ' holding=npm 18m pid=23');
  // Codex and agy run a command as `bash -lc '<cmd>'`, which bash replaces by the command: the agent's
  // own child, started after it; its MCP server started with it.
  const codex = [
    { pid: '100', ppid: '1', etime: '50:00', args: '/opt/codex/bin/codex exec --json' },
    { pid: '101', ppid: '100', etime: '49:59', args: 'node /opt/mcp/server.js' },
    { pid: '102', ppid: '100', etime: '35:10', args: 'npm exec some-cli' },
  ];
  assert.equal(w.heldBy('/wt', () => codex), ' holding=npm 35m pid=102');
  assert.equal(w.heldBy('/wt', () => codex.slice(0, 2)), '', 'a helper started with the agent holds nothing');
  assert.equal(w.heldBy('/wt', () => { throw new Error('no lsof'); }), '');
  assert.equal(w.minutesOf('1-02:03:04'), 1440 + 120 + 3);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stall-held-'));
  try {
    const line = w.status({ dispatch: 'ctx_held', idle: 10, errors: 3, askMax: 60 }, {
      show: () => ({ state: 'running', workspace: `wt1::${dir}` }),
      newErrors: () => 0,
      waitingAsk: () => false,
      heldBy: () => ' holding=npm 18m pid=12',
      now: Date.now() + 3600000,
    });
    assert.equal(line, 'stale idle>10m holding=npm 18m pid=12 state=running');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('worker-stall: heldBy finds a real process by its working directory', { skip: spawnSync('lsof', ['-v']).error && 'no lsof' }, async () => {
  const w = require('../claude/scripts/worker-stall.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stall-real-'));
  const child = require('child_process').spawn('sleep', ['30'], { cwd: dir, stdio: 'ignore' });
  try {
    await new Promise((r) => setTimeout(r, 300));
    assert.match(w.heldBy(dir), /^ holding=sleep \d+m pid=\d+$/);
  } finally {
    child.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('user-intent: a request for an answer waits like a question; a work order does not', () => {
  const { isQuestion } = require('../claude/hooks/lib/user-intent.cjs');
  for (const t of [
    'cho tôi câu lệnh để tôi chạy, đừng để placeholder như thế',
    'gửi tôi link PR nhé',
    'giải thích kĩ phần này',
  ]) assert.equal(isQuestion(t), true, t);
  for (const t of [
    'đã tạo secret rồi, làm tiếp plan đi',
    'cho phép vượt cap 4 nhé',
    'ok chạy plan đi',
    'chạy backfill dag sales từ 1/11 đến 20/11, xong gửi tôi link log',
    'làm hết, xong gửi anh link PR',
    'triển khai đi, rồi cho tôi xem bảng kết quả',
    'unpause dag x và thêm comment giải thích vào README',
    'fix bug, tell me when done',
    'Thêm bước liệt kê cho từng worker',
    'chạy serial, giải thích ngắn trong PR',
    'giải thích rồi sửa luôn',
    'liệt kê worker rồi dừng hết',
  ]) assert.equal(isQuestion(t), false, t);
});

test('ask-batch-guard: a message the user typed mid-turn lets the parked ask through', () => {
  const { spacedAsk } = require('../claude/hooks/ask-batch-guard.cjs');
  const answered = { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'q1', content: 'Your questions have been answered: x' }] } };
  const tool = { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'b', name: 'Bash', input: {} }] } };
  const typed = { type: 'attachment', attachment: { type: 'queued_command', prompt: 'dừng lại, hỏi tôi về tên bảng', origin: { kind: 'human' } } };
  assert.equal(spacedAsk([answered, tool]), 'q1', 'held without it');
  assert.equal(spacedAsk([answered, tool, typed]), null);
});

test('ask-format-guard: a question longer than one line (sentences, a list, a draft) is held once', () => {
  const { runOnQuestions } = require('../claude/hooks/ask-format-guard.cjs');
  const runOn = 'Bản báo cáo tuần đã có đủ số liệu. Hai biểu đồ còn thiếu nhãn trục. Gửi bản này trước không?';
  const bulleted = 'Báo cáo tuần:\n- Số liệu đã đủ.\n- Hai biểu đồ còn thiếu nhãn trục.\n- Gửi bản này trước không?';
  const oneLine = 'Plan ~/.claude/plans/x/261125-bao-cao.md: gửi bản báo cáo tuần trước khi đủ nhãn trục?';
  assert.deepEqual(runOnQuestions({ questions: [{ question: runOn }] }), [runOn]);
  assert.deepEqual(runOnQuestions({ questions: [{ question: bulleted }] }), [bulleted], 'a list belongs in the message before the ask');
  assert.equal(runOnQuestions({ questions: [{ question: '(a) Gửi bản nháp.\n(b) Chờ thêm số liệu?' }] }).length, 1, 'lettered lines too');
  assert.equal(runOnQuestions({ questions: [{ question: 'Gửi tin này cho chị Lan không?\n\n"Dạ chị ơi, em kiểm xong rồi. Chị xem giúp em nhé."' }] }).length, 1,
    'a draft belongs in the message before the ask');
  assert.deepEqual(runOnQuestions({ questions: [{ question: oneLine }] }), [], 'one line naming the plan and what it decides passes');
  assert.deepEqual(runOnQuestions({ questions: [{ question: 'Gửi báo cáo tuần cho nhóm kho không?' }] }), [], 'one sentence passes');
  assert.deepEqual(runOnQuestions({ questions: [{ question: 'Cho Claude đọc file môi trường, nhãn "Cho phép đọc. Chỉ 5 câu."?' }] }), [], 'a quoted phrase is no sentence');
  assert.deepEqual(runOnQuestions({ questions: [{ question: 'Dựng bảng tạm theo kế hoạch dưới đây (nhánh mới, bản nháp; chưa merge) được không?' }] }), [],
    'a semicolon inside a parenthesised aside ends no sentence');
  assert.equal(runOnQuestions({ questions: [{ question: 'Số dư đầu kỳ lấy từ đâu? (Trả lời câu này là đồng ý dựng tab mới. Claude mở PR, chưa merge.)' }] }).length, 1,
    'an aside that runs sentences is context and counts');
  assert.deepEqual(runOnQuestions({ questions: [{ question: 'II. Kế hoạch thu tiền tháng này là số nào?' }] }), [], 'a roman-numeral label is no sentence');
  assert.deepEqual(runOnQuestions({}), []);
  const call = { hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', session_id: sid('ask-format'), tool_input: { questions: [{ question: oneLine }, { question: runOn }] } };
  const held = hook('ask-format-guard.cjs', call);
  assert.equal(held.status, 2);
  assert.match(held.stderr, /message just before the ask/);
  assert.equal(hook('ask-format-guard.cjs', call).status, 0, 'the same ask sent again passes');
  assert.equal(hook('ask-format-guard.cjs', { ...call, tool_input: { questions: [{ question: oneLine }] } }).status, 0);
  assert.equal(hook('ask-format-guard.cjs', { ...call, tool_name: 'Bash' }).status, 0);
});

test('ask-format-guard: an ask with no text of the reply since the last tool result or user message is held once', () => {
  const { hasContext } = require('../claude/hooks/ask-format-guard.cjs');
  const typed = { type: 'user', message: { content: 'chốt plan nhé' } };
  const text = { type: 'assistant', message: { content: [{ type: 'text', text: '# Bối cảnh\nĐã kiểm xong.' }] } };
  const think = { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'Phiếu đã khớp schema, tôi sẽ hỏi bước duyệt' }] } };
  const edit = { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'e1', name: 'Edit', input: {} }] } };
  const ask1 = { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'q1', name: 'AskUserQuestion', input: {} }] } };
  const held = { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'q1', is_error: true, content: 'PreToolUse:AskUserQuestion hook error' }] } };
  const meta = { type: 'user', isMeta: true, message: { content: [{ type: 'text', text: '<system-reminder>x</system-reminder>' }] } };
  const other = { type: 'attachment' };
  assert.equal(hasContext([typed, think, text, other]), true, 'text before the ask, thinking before it');
  assert.equal(hasContext([typed, text, edit]), true, 'a parallel call of the same reply does not hide its text');
  assert.equal(hasContext([typed, think]), false, 'only thinking since the user wrote');
  assert.equal(hasContext([typed, think, think, edit, edit]), false, 'the report sat in thinking, then edits, then the ask');
  assert.equal(hasContext([typed, text, ask1, held, think]), false, 'the ask sent again after a hook held it');
  assert.equal(hasContext([typed, text, ask1, held, meta, think]), false, 'a system reminder is no message of the user');
  assert.equal(hasContext([typed, text, ask1, held, text]), true, 'context written again before the second ask');
  assert.equal(hasContext([think]), true, 'a tail that cannot tell fails open');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'afg-'));
  const transcript = path.join(tmp, 't.jsonl');
  fs.writeFileSync(transcript, [typed, text, ask1, held, think].map((r) => JSON.stringify(r)).join('\n') + '\n');
  const call = { hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', session_id: sid('ask-context'), transcript_path: transcript,
    tool_input: { questions: [{ question: 'Chạy plan ~/.claude/plans/x/261126-a.md bằng autopilot chứ?' }] } };
  const first = hook('ask-format-guard.cjs', call);
  assert.equal(first.status, 2);
  assert.match(first.stderr, /text right before the ask/);
  assert.equal(hook('ask-format-guard.cjs', call).status, 0, 'the same ask sent again passes');
  fs.writeFileSync(transcript, [typed, text].map((r) => JSON.stringify(r)).join('\n') + '\n');
  assert.equal(hook('ask-format-guard.cjs', { ...call, session_id: sid('ask-context-2') }).status, 0, 'an ask after text passes');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('worker-stall: the checkout of a new worktree is no change; a file the worker writes later is', () => {
  const w = require('../claude/scripts/worker-stall.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nudge-born-'));
  try {
    fs.writeFileSync(path.join(dir, '.gitignore'), 'x'); // written by the checkout, at the worktree's birth
    const born = fs.statSync(dir).birthtimeMs;
    if (!born) return; // a filesystem with no birth time: every file counts, as before
    const show = () => ({ state: 'ready', workspace: `id::${dir}` });
    const deps = (now) => ({ show, newErrors: () => 0, waitingAsk: () => null, heldBy: () => '', now, stateDir: path.join(os.tmpdir(), `nudge-born-state-${process.pid}`) });
    const o = { dispatch: 'ctx_born', idle: 10, errors: 3 };
    assert.equal(w.status(o, deps(born + 2 * 60000)), 'running new-worktree=2m state=ready', 'not changed=.gitignore');
    const edited = path.join(dir, 'src.js');
    fs.writeFileSync(edited, 'y');
    const later = new Date(born + 3 * 60000);
    fs.utimesSync(edited, later, later);
    assert.equal(w.status(o, deps(born + 4 * 60000)), 'running changed=src.js state=ready');
    assert.match(w.status(o, deps(born + 30 * 60000)), /^stale idle>10m/, 'an old worktree with nothing new is stale');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('worker-start-receipt: on Windows, agy run in a terminal (no Orca chat home) gets no chat-config warning', () => {
  const { acpHomes, agyConfigLines } = require('../claude/hooks/worker-start-receipt.cjs');
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'nudge-orca-data-'));
  try {
    assert.deepEqual(acpHomes('win32', () => data), [], 'no antigravity-chat folder: nothing to check');
    assert.deepEqual(agyConfigLines(acpHomes('win32', () => data)), []);
    const chat = path.join(data, 'antigravity-chat');
    fs.mkdirSync(chat);
    assert.deepEqual(acpHomes('win32', () => data), [chat], 'Orca chat in use: its config is checked');
    assert.match(agyConfigLines([chat], data)[0], /không trỏ về/, 'a chat home whose config is not linked is still told');
  } finally { fs.rmSync(data, { recursive: true, force: true }); }
});

test('ask-batch-guard: the final gate of a draft plan whose open questions were just answered passes; asks during its run do not', () => {
  const { spacedAsk } = require('../claude/hooks/ask-batch-guard.cjs');
  const user = (content) => ({ type: 'user', message: { role: 'user', content } });
  const ask = (id, question) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'AskUserQuestion', input: { questions: [{ question }] } }] } });
  const answer = (id) => user([{ type: 'tool_result', tool_use_id: id, content: 'Your questions have been answered: "x"="Claude tạo qua API". You can now continue with these answers in mind.' }]);
  const tool = (id, name, input) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
  const result = (id) => user([{ type: 'tool_result', tool_use_id: id, content: 'ok' }]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'abg-plans-'));
  try {
    fs.mkdirSync(path.join(dir, 'plans', '-Users-x'), { recursive: true });
    const plan = path.join(dir, 'plans', '-Users-x', '261125-header-auth.md');
    const other = path.join(dir, 'plans', '-Users-x', '261125-other.md');
    fs.writeFileSync(plan, '---\nstatus: draft\nsession: s\n---\n# Plan\n');
    fs.writeFileSync(other, '---\nstatus: draft\n---\n');
    // The plan's answers written with Bash, its prerequisites read again, then its gate.
    const block = [user('làm plan Header Auth'), ask('q1', `Plan ${plan}: ai tạo credential?`), answer('q1'),
      tool('t1', 'Bash', { command: `python3 edit_plan.py ${plan}` }), result('t1'), tool('t2', 'Bash', { command: 'gh auth status' }), result('t2')];
    assert.equal(spacedAsk(block, { questions: [{ question: `Chạy plan ${plan} trên autopilot?` }] }), null, 'the gate of the same draft plan');
    assert.equal(spacedAsk(block, { questions: [{ question: `Chạy plan ${other}?` }] }), 'q1', 'another plan stays held');
    assert.equal(spacedAsk(block, { questions: [{ question: 'Đăng comment trả #489?' }] }), 'q1', 'an ask naming no plan stays held');
    assert.equal(spacedAsk(block), 'q1', 'no next ask given: held as before');
    // Approved and running: an ask naming the plan mid-run is held, as any.
    fs.writeFileSync(plan, '---\nstatus: approved\nsession: s\n---\n# Plan\n');
    assert.equal(spacedAsk(block, { questions: [{ question: `Plan ${plan}: merge PR #12 trước khi CI xanh?` }] }), 'q1', 'a running plan asks nothing');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('worker-stall: a worker that only reads, its last message recent, is running; silent past --idle-min, stale', () => {
  const w = require('../claude/scripts/worker-stall.cjs');
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'nudge-said-'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nudge-old-ws-'));
  try {
    // An old worktree (a worker given an existing one): nothing in it changes while the worker reads.
    const old = new Date(Date.now() - 60 * 60000);
    fs.writeFileSync(path.join(dir, 'a.py'), 'x');
    fs.utimesSync(path.join(dir, 'a.py'), old, old);
    const now = Date.now();
    const reading = { role: 'assistant', timestamp: now - 60000, blocks: [{ type: 'tool-call', name: 'Read', input: { file_path: 'a.py' } }] };
    const page = (messages) => () => ({ result: { transcript: { messages, limited: false, nextCursor: 'c' } } });
    const o = { dispatch: 'ctx_said', idle: 10, errors: 3 };
    const deps = (msgs, at) => ({ show: () => ({ state: 'ready', workspace: `id::${dir}` }), now: at, heldBy: () => '',
      newErrors: (d) => w.newErrors(d, page(msgs), state), waitingAsk: () => false, lastMessage: (d) => w.lastMessage(d, state) });
    assert.equal(w.status(o, deps([reading], now)), 'running said=1m state=ready', 'dispatched a minute ago, reading');
    assert.match(w.status(o, deps([], now + 15 * 60000)), /^stale idle>10m/, 'its last message 16 minutes old');
    assert.match(w.status(o, deps([{ role: 'user', timestamp: now + 15 * 60000, blocks: [] }], now + 15 * 60000)), /^stale idle>10m/, 'a coordinator message is no step of the worker');
  } finally {
    fs.rmSync(state, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('watch.sh: a space-separated --ok/--wait list is refused at once; a comma-separated one waits on each state', { skip: spawnSync('bash', ['--version']).error && 'no bash' }, () => {
  const script = path.join(__dirname, '..', 'claude', 'scripts', 'watch.sh');
  const run = (...a) => spawnSync('bash', [script, '--once', '--check', 'echo IN_PROGRESS shopify theme check', ...a], { encoding: 'utf8' });
  const spaced = run('--ok', 'SUCCESS', '--wait', 'IN_PROGRESS QUEUED PENDING');
  assert.notEqual(spaced.status, 0);
  assert.match(spaced.stderr + spaced.stdout, /comma-separated/);
  const listed = run('--ok', 'SUCCESS', '--wait', 'IN_PROGRESS,QUEUED,PENDING');
  assert.doesNotMatch(listed.stderr + listed.stdout, /comma-separated|UNEXPECTED/);
});
