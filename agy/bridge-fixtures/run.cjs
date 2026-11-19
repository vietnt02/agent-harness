#!/usr/bin/env node
/**
 * Replays real agy hook payloads (payloads.json: agy CLI and Orca's agy chat runtime) through
 * ../claude-hook-bridge.cjs and checks each guard decision and worker detection.
 * Run after any change to the bridge, and whenever agy or Orca's agy runtime changes version:
 *   node ~/.gemini/config/bridge-fixtures/run.cjs
 * A new version can change the payload itself; this only replays the shapes in payloads.json. When
 * a version changes, capture a fresh payload of each kind (a hook that appends stdin to a file) and
 * compare its keys with payloads.json before trusting a green run.
 * The bridge records the key shape of every real payload in seen-shapes.json (keys only). A green run
 * records the installed agy versions in tested-versions.json (which worker-start-receipt compares with
 * the installed ones) only when payloads seen since those versions were installed all have a shape
 * payloads.json replays: a green replay of old shapes says nothing about a new version.
 * Exit 0: every case passes and the versions are recorded. 1: a case fails, or the installed agy sent a
 * shape payloads.json lacks (capture it and add it). 3: cases pass, but no payload has been seen since
 * the installed versions arrived, so nothing is recorded yet (the next agy run settles it).
 * Otherwise writes only under a temp dir.
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BRIDGE = path.join(__dirname, '..', 'claude-hook-bridge.cjs');
// Per-machine files live beside the installed copy (~/.gemini/config/bridge-fixtures), not in the
// repo this file may be symlinked from: Node resolves a symlinked script to its real path.
const LOCAL_DIR = path.join(os.homedir(), '.gemini', 'config', 'bridge-fixtures');
const STAMP = path.join(LOCAL_DIR, 'tested-versions.json');

let orcaDataDir = () => path.join(os.homedir(), 'Library', 'Application Support', 'orca');
try {
  const platPath = path.join(os.homedir(), '.claude', 'hooks', 'lib', 'platform.cjs');
  const plat = require(platPath);
  if (typeof plat.orcaDataDir === 'function') orcaDataDir = plat.orcaDataDir;
} catch (_) {
  try {
    const localPlat = require(path.join(__dirname, '..', '..', 'claude', 'hooks', 'lib', 'platform.cjs'));
    if (typeof localPlat.orcaDataDir === 'function') orcaDataDir = localPlat.orcaDataDir;
  } catch (_) {
    // thiếu file thì về đường dẫn macOS như cũ
  }
}
const RUNTIMES = path.join(orcaDataDir(), 'agent-runtimes', 'antigravity');

// The agy versions whose payloads reach the bridge: the CLI on PATH and Orca's chat runtimes.
function versions() {
  let cli = '';
  try { cli = spawnSync('agy', ['--version'], { encoding: 'utf8', timeout: 5000 }).stdout.trim(); } catch (_) { /* none */ }
  let runtimes = [];
  try { runtimes = fs.readdirSync(RUNTIMES).filter((d) => !d.startsWith('.')).sort(); } catch (_) { /* none */ }
  return { cli, runtimes };
}
const TEMPLATES = JSON.parse(fs.readFileSync(path.join(__dirname, 'payloads.json'), 'utf8'));
const PREAMBLE = 'You are working inside Orca, a multi-agent IDE. You are a dispatched worker.';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-fixtures-'));
const ws = path.join(root, 'ws');
fs.mkdirSync(ws);
fs.writeFileSync(path.join(ws, '.env'), 'FIXTURE=not-a-secret\n');
fs.writeFileSync(path.join(ws, 'README.md'), '# fixture\n');

let n = 0;
// A conversation laid out as the given mode stores it; `worker` puts the Orca preamble first.
function conversation(mode, worker, hasBrain = true) {
  const cid = `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
  const firstInput = { type: 'USER_INPUT', content: worker ? `${PREAMBLE}\nTask: x` : 'Kiểm pipeline hôm nay', step_index: 0 };
  if (mode === 'cli') {
    const brain = path.join(root, 'cli', 'brain', cid);
    fs.mkdirSync(path.join(brain, '.system_generated', 'logs'), { recursive: true });
    const transcript = path.join(brain, '.system_generated', 'logs', 'transcript_full.jsonl');
    fs.writeFileSync(transcript, JSON.stringify(firstInput) + '\n');
    return { cid, transcript, vars: { '{CLI_BRAIN}': brain, '{CID}': cid, '{WS}': ws } };
  }
  const gh = path.join(root, 'chat');
  const acp = path.join(gh, 'antigravity-acp');
  fs.mkdirSync(path.join(acp, 'conversations'), { recursive: true });
  fs.writeFileSync(path.join(acp, 'conversations', `${cid}.db`), '');
  let transcript = '';
  if (hasBrain) {
    const logs = path.join(acp, 'brain', cid, '.system_generated', 'logs');
    fs.mkdirSync(logs, { recursive: true });
    transcript = path.join(logs, 'transcript.jsonl');
    fs.writeFileSync(transcript, JSON.stringify(firstInput) + '\n');
  }
  fs.mkdirSync(path.join(gh, 'artifacts'), { recursive: true }); // the shared dir Orca names
  return { cid, transcript, vars: { '{ACP}': acp, '{GH}': gh, '{CID}': cid, '{WS}': ws } };
}

function payload(mode, convo, toolCall, extra = {}) {
  let text = JSON.stringify(TEMPLATES[mode]);
  for (const [k, v] of Object.entries(convo.vars)) text = text.split(k).join(v);
  return { ...JSON.parse(text), toolCall, ...extra };
}

function bridgeFull(p, tmp, event = 'PreToolUse') {
  const r = spawnSync(process.execPath, [BRIDGE, event], {
    input: JSON.stringify(p), encoding: 'utf8', timeout: 20000, env: { ...process.env, TMPDIR: tmp, BRIDGE_FIXTURE: '1' },
  });
  if (r.error || r.status !== 0) return { decision: `crash (${r.error ? r.error.message : `exit ${r.status}`})`, reason: '' };
  try {
    const out = JSON.parse(r.stdout || '{}');
    return { decision: out.decision || 'allow', reason: String(out.reason || '') };
  } catch (_) {
    return { decision: 'unparsable output', reason: '' };
  }
}

function bridge(p, tmp) {
  return bridgeFull(p, tmp, 'PreToolUse').decision;
}

// Worker mode as the bridge stored it for this conversation, wherever it put it.
function storedMode(mode, convo, tmp) {
  const files = [path.join(tmp, `agy-hook-state-${convo.cid}.json`)];
  if (mode === 'cli') files.push(path.join(convo.vars['{CLI_BRAIN}'], '.system_generated', 'agy-hook-state.json'));
  else {
    files.push(path.join(convo.vars['{GH}'], 'artifacts', '.system_generated', 'agy-hook-state.json'));
    if (convo.vars['{ACP}']) files.push(path.join(convo.vars['{ACP}'], 'brain', convo.cid, '.system_generated', 'agy-hook-state.json'));
  }
  for (const f of files) { try { return JSON.parse(fs.readFileSync(f, 'utf8')).mode || null; } catch (_) { /* next */ } }
  return null;
}

const hasAgentKitLib = (lib) => fs.existsSync(path.join(os.homedir(), '.claude', 'hooks', 'lib', lib));

const env = path.join(ws, '.env');
const readme = path.join(ws, 'README.md');
const cases = [
  ['cli read_file Path .env', 'cli', { id: 'toolu_01', name: 'read_file', args: { Path: env } }, 'deny', undefined, 'privacy-checker.cjs'],
  ['cli read_file Path README', 'cli', { id: 'toolu_01', name: 'read_file', args: { Path: readme } }, 'allow', undefined, 'privacy-checker.cjs'],
  ['cli run_command git status', 'cli', { id: 'toolu_01', name: 'run_command', args: { CommandLine: 'git status --short' } }, 'allow'],
  ['chat view_file AbsolutePath .env', 'chat', { name: 'view_file', args: { AbsolutePath: env } }, 'deny', undefined, 'privacy-checker.cjs'],
  ['chat view_file absolute_path .env', 'chat', { name: 'view_file', args: { absolute_path: env } }, 'deny', undefined, 'privacy-checker.cjs'],
  ['chat view_file absolute_path README', 'chat', { name: 'view_file', args: { absolute_path: readme } }, 'allow', undefined, 'privacy-checker.cjs'],
  ['chat run_command ls', 'chat', { name: 'run_command', args: { CommandLine: 'ls', Cwd: ws } }, 'allow'],
  // A message that only names a secret file prints nothing: the same verdict as Claude's secret-file-guard.
  ['chat run_command ask naming .env', 'chat', { name: 'run_command', args: { CommandLine: 'orca orchestration ask --question "chỉ sửa x.sql, không đọc .env"', Cwd: ws } }, 'allow', undefined, 'privacy-checker.cjs'],
  ['chat run_command cat .env', 'chat', { name: 'run_command', args: { CommandLine: 'cat .env', Cwd: ws } }, 'deny', undefined, 'privacy-checker.cjs'],
  ['malformed: empty arg key', 'chat', { name: 'view_file', args: { '': 1, absolute_path: env } }, 'deny', undefined, 'privacy-checker.cjs'],
  ['malformed: transcriptPath number', 'chat', { name: 'view_file', args: { AbsolutePath: env } }, 'deny', { transcriptPath: 5 }, 'privacy-checker.cjs'],
];

let failed = 0;
const report = (ok, name, detail) => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`); };

for (const [name, mode, toolCall, want, extra, requiredLib] of cases) {
  if (requiredLib && !hasAgentKitLib(requiredLib)) {
    console.log(`SKIP  ${name} (thiếu ${requiredLib})`);
    continue;
  }
  const tmp = fs.mkdtempSync(path.join(root, 'tmp-'));
  const got = bridge(payload(mode, conversation(mode, false), toolCall, extra), tmp);
  report(got === want, name, got === want ? '' : `got ${got}, want ${want}`);
}

// A docker write on another host over ssh (a worker: always denied; a direct session: gated when the
// user's latest words are a question), a command printing a container's config (held once per
// conversation), and a message body quoting build output (scout reads no free text).
{
  const run = (cmd) => ({ name: 'run_command', args: { CommandLine: cmd, Cwd: ws } });
  const start = (mode, worker, said) => {
    const convo = conversation(mode, worker);
    if (said) fs.appendFileSync(convo.transcript, JSON.stringify({ type: 'USER_INPUT', content: said, step_index: 3 }) + '\n');
    return convo;
  };
  // A report quoting vite build output, cut down from the reports AgentKit's scout checker denied: it
  // reads `dist` or `node_modules` as a whole path segment of the text (a line opening with `dist/`, a
  // `…/dist/…` inside one), here after two lines with parentheses, which the variable shape needs to be
  // denied. Sent in the three shapes workers used: a heredoc in --body, a heredoc in a variable, $'…'.
  const log = '- Lượt gọi xấu nhất (1000 dòng): 33,91 ms.\n- So với trần (500 dòng): thấp hơn ~235 lần.\n' +
    'vite v8.2.1 building client environment for production...\n' +
    'transforming (353) node_modules/@supabase/realtime-js/dist/module/phoenix/channe\n' +
    '✓ 693 modules transformed.\n' +
    'dist/registerSW.js                            0.13 kB\n' +
    'dist/assets/index-abc.js                      1.20 kB';
  const send = '--from term_x --type worker_done --subject "PASS: review xong" --task-id task_x --dispatch-id ctx_x --outcome succeeded';
  // [name, mode, worker, the user's latest words, command, want, reason pattern, AgentKit lib needed]
  const remoteCases = [
    ['worker: ssh docker run', 'chat', true, null, "ssh vps_n8n 'docker run --rm -v n8n_data:/data alpine cat /data/config'",
      'deny', /a worker never makes[\s\S]*docker exec/],
    ['worker: ssh docker ps', 'chat', true, null, "ssh vps_n8n 'docker ps --format {{.Names}}'", 'allow'],
    ['direct: ssh docker pull after a go-ahead', 'cli', false, 'làm đi', 'ssh vps_airflow docker pull alpine', 'allow'],
    ['direct: ssh docker pull after a question', 'cli', false, 'xoá image chưa?', 'ssh vps_airflow docker pull alpine',
      'deny', /is tier C, but the user's latest words/],
    ['worker_done --body "$(cat <<EOF …)" quoting build output', 'chat', true, null,
      `orca orchestration send ${send} --body "$(cat <<'EOF'\n${log}\nEOF\n)"`, 'allow', null, 'scout-checker.cjs'],
    ['BODY=$(cat <<EOF …) quoting build output, then --body "$BODY"', 'chat', true, null,
      `BODY=$(cat <<'EOF'\n${log}\nEOF\n)\norca orchestration send ${send} --body "$BODY"`, 'allow', null, 'scout-checker.cjs'],
    ["ask --question $'…' naming a build path", 'chat', true, null,
      "orca orchestration ask --from term_x --question $'Kế hoạch:\\n- bỏ ../dist/tasks khỏi build\\n- giữ \\\"Tổng quan\\\"'", 'allow', null, 'scout-checker.cjs'],
    ['git commit -m "$(cat <<EOF …)" quoting build output', 'cli', false, null,
      `git commit -m "$(cat <<'EOF'\nbuild: move the PWA files\n\n${log}\nEOF\n)"`, 'allow', null, 'scout-checker.cjs'],
    ['glab mr create --description "$(cat <<EOF …)" quoting build output', 'chat', true, null,
      `glab mr create --title "fix: x" --description "$(cat <<'EOF'\n${log}\nEOF\n)"`, 'allow', null, 'scout-checker.cjs'],
    ['glab mr note --message quoting build output', 'chat', true, null,
      `glab mr note 12 --message "$(cat <<'EOF'\n${log}\nEOF\n)"`, 'allow', null, 'scout-checker.cjs'],
    ['a report written with cat > file <<EOF quoting build output', 'chat', true, null,
      `cat > /tmp/report.md <<'EOF'\n${log}\nEOF`, 'allow', null, 'scout-checker.cjs'],
    ['a script fed to bash still has its reads checked', 'chat', true, null,
      "bash <<'EOF'\nls dist/\nEOF", 'deny', /SCOUT BLOCK/, 'scout-checker.cjs'],
    ['a message sent beside a real read: the read is still blocked', 'chat', true, null,
      `orca orchestration send ${send} --body "xong" && ls dist/`, 'deny', /SCOUT BLOCK/, 'scout-checker.cjs'],
    ['ls dist/ still blocked', 'chat', true, null, 'ls dist/', 'deny', /SCOUT BLOCK/, 'scout-checker.cjs'],
  ];
  for (const [name, mode, worker, said, cmd, want, why, requiredLib] of remoteCases) {
    if (requiredLib && !hasAgentKitLib(requiredLib)) {
      console.log(`SKIP  ${name} (thiếu ${requiredLib})`);
      continue;
    }
    const tmp = fs.mkdtempSync(path.join(root, 'tmp-'));
    const got = bridgeFull(payload(mode, start(mode, worker, said), run(cmd)), tmp);
    const ok = got.decision === want && (!why || why.test(got.reason));
    report(ok, name, ok ? '' : `got ${got.decision}: ${got.reason.slice(0, 160)}`);
  }
  {
    const name = 'docker inspect of the config: denied once per conversation, then passes';
    const tmp = fs.mkdtempSync(path.join(root, 'tmp-'));
    const convo = start('chat', true, null);
    const first = bridgeFull(payload('chat', convo, run('ssh vps_n8n docker inspect n8n-redis')), tmp);
    const second = bridgeFull(payload('chat', convo, run('ssh vps_n8n docker inspect n8n-redis')), tmp);
    const ok = first.decision === 'deny' && /Print names only/.test(first.reason) && second.decision === 'allow';
    report(ok, name, ok ? '' : `first=${first.decision}, second=${second.decision}`);
  }
}

// Umbrella sub-repo guard: a copy of the umbrella's real nap-context-repo-con.cjs in a fake umbrella
// above the temp dir. The hook only reminds: the first non-Read touch in a sub-repo is allowed and queues one
// reminder naming AGENTS.md and read_file, which agy gets at its next step (PreInvocation); later commands in
// that sub-repo stay silent until compaction; another sub-repo is reminded on its own.
// Path of an umbrella's nap-context-repo-con.cjs: NAP_HOOK_PATH, else local.json `{"napHook": "<abs path>"}`.
const NAP = process.env.NAP_HOOK_PATH || (() => {
  try { return JSON.parse(fs.readFileSync(path.join(LOCAL_DIR, 'local.json'), 'utf8')).napHook || ''; } catch (_) { return ''; }
})();
if (NAP && fs.existsSync(NAP)) {
  const umbrella = path.join(root, 'umbrella');
  const repo = path.join(umbrella, 'repos', 'systems', 'demo');
  const otherRepo = path.join(umbrella, 'repos', 'systems', 'other');
  const hooksDst = path.join(umbrella, '.claude', 'hooks');
  fs.mkdirSync(hooksDst, { recursive: true });
  fs.copyFileSync(NAP, path.join(hooksDst, 'nap-context-repo-con.cjs'));
  const libSrc = path.join(path.dirname(NAP), 'lib');
  if (fs.existsSync(libSrc)) fs.cpSync(libSrc, path.join(hooksDst, 'lib'), { recursive: true });
  // Each sub-repo has its own rules: the hook passes a repo whose rule files match ones already read.
  for (const r of [repo, otherRepo]) {
    fs.mkdirSync(path.join(r, '.git'), { recursive: true });
    fs.writeFileSync(path.join(r, 'CLAUDE.md'), `# rules of ${path.basename(r)}\n`);
    fs.writeFileSync(path.join(r, 'AGENTS.md'), `# rules of ${path.basename(r)}\n`);
  }
  const home = { workspacePaths: [os.homedir()] };
  // One tool call: its decision, then the reminder agy gets before its next step ('' when none).
  const touch = (mode, convo, toolCall, ctx, tmp) => {
    const decision = bridge(payload(mode, convo, toolCall, ctx), tmp);
    const r = spawnSync(process.execPath, [BRIDGE, 'PreInvocation'], {
      input: JSON.stringify(payload(mode, convo, undefined, { ...ctx, toolCall: undefined })),
      encoding: 'utf8', timeout: 20000, env: { ...process.env, TMPDIR: tmp, BRIDGE_FIXTURE: '1' },
    });
    let note = '';
    try { note = (JSON.parse(r.stdout || '{}').injectSteps || []).map((s) => s.ephemeralMessage || '').join('\n'); } catch (_) { /* none */ }
    return { decision, note };
  };
  const remindsOf = (t, name) => t.decision === 'allow' && new RegExp(`${name}[\\\\/]AGENTS\\.md`).test(t.note) &&
    !/CLAUDE\.md/.test(t.note) && /read_file/.test(t.note);
  const silent = (t) => t.decision === 'allow' && !/AGENTS\.md/.test(t.note);
  const show = (t) => `${t.decision}/${t.note ? 'reminded' : 'silent'}`;
  const run = (cmd, cwd) => ({ name: 'run_command', args: { CommandLine: cmd, Cwd: cwd } });

  {
    const name = 'umbrella: first command in sub-repo is allowed and reminds once, naming AGENTS.md and read_file';
    const tmp = fs.mkdtempSync(path.join(root, 'tmp-'));
    const convo = conversation('chat', false);
    const first = touch('chat', convo, run('ls', repo), home, tmp);
    const ok = remindsOf(first, 'demo');
    report(ok, name, ok ? '' : `decision=${first.decision}, note=${first.note.slice(0, 120)}`);
  }
  {
    const name = 'umbrella: one command touching two sub-repos names both AGENTS.md, no CLAUDE.md';
    const tmp = fs.mkdtempSync(path.join(root, 'tmp-'));
    const convo = conversation('chat', false);
    const both = touch('chat', convo, run(`ls ${repo} ${otherRepo}`, umbrella), home, tmp);
    const ok = remindsOf(both, 'demo') && remindsOf(both, 'other');
    report(ok, name, ok ? '' : `decision=${both.decision}, note=${both.note.slice(0, 200)}`);
  }
  {
    const name = 'umbrella: cli payload.cwd without args.Cwd reminds once then stays silent';
    const tmp = fs.mkdtempSync(path.join(root, 'tmp-'));
    const convo = conversation('cli', false);
    const cliCtx = { workspacePaths: [os.homedir()], cwd: repo };
    const first = touch('cli', convo, { id: 'toolu_01', name: 'run_command', args: { CommandLine: 'ls' } }, cliCtx, tmp);
    const second = touch('cli', convo, { id: 'toolu_02', name: 'run_command', args: { CommandLine: 'pwd' } }, cliCtx, tmp);
    const ok = remindsOf(first, 'demo') && silent(second);
    report(ok, name, ok ? '' : `first=${show(first)}, second=${show(second)}`);
  }
  {
    const name = 'umbrella: different command in same sub-repo stays silent (TMPDIR=A -> TMPDIR=B, state in brain) and other sub-repo is reminded once';
    const tmpA = fs.mkdtempSync(path.join(root, 'tmp-a-'));
    const tmpB = fs.mkdtempSync(path.join(root, 'tmp-b-'));
    const convo = conversation('chat', false);
    const brainDir = path.join(convo.vars['{ACP}'], 'brain', convo.cid, '.system_generated');
    const first = touch('chat', convo, run('ls', repo), home, tmpA);
    const second = touch('chat', convo, run('pwd', repo), home, tmpB);
    const otherFirst = touch('chat', convo, run('ls', otherRepo), home, tmpB);
    const otherSecond = touch('chat', convo, run('pwd', otherRepo), home, tmpB);
    const napBrainState = path.join(brainDir, 'claude-nap-context-repo-con');
    const napTmpA = path.join(tmpA, 'claude-nap-context-repo-con');
    const napTmpB = path.join(tmpB, 'claude-nap-context-repo-con');
    const stateInBrain = fs.existsSync(napBrainState) && !fs.existsSync(napTmpA) && !fs.existsSync(napTmpB);
    const ok = remindsOf(first, 'demo') && silent(second) && stateInBrain &&
      remindsOf(otherFirst, 'other') && !/demo/.test(otherFirst.note) && silent(otherSecond);
    report(ok, name, ok ? '' : `first=${show(first)}, second=${show(second)}, stateInBrain=${stateInBrain}, otherFirst=${show(otherFirst)}, otherSecond=${show(otherSecond)}`);
  }
  {
    const name = 'umbrella: after compaction (CHECKPOINT + PreInvocation), sub-repo is reminded once again';
    const tmp = fs.mkdtempSync(path.join(root, 'tmp-'));
    const convo = conversation('chat', false);
    bridgeFull(payload('chat', convo, undefined, { ...home, toolCall: undefined }), tmp, 'PreInvocation');
    const first = touch('chat', convo, run('ls', repo), home, tmp);
    const second = touch('chat', convo, run('pwd', repo), home, tmp);
    fs.appendFileSync(convo.transcript, JSON.stringify({ type: 'CHECKPOINT', step_index: 5 }) + '\n');
    bridgeFull(payload('chat', convo, undefined, { ...home, toolCall: undefined }), tmp, 'PreInvocation');
    const afterCompact = touch('chat', convo, run('ls -a', repo), home, tmp);
    const afterCompactNext = touch('chat', convo, run('ls -1', repo), home, tmp);
    const ok = remindsOf(first, 'demo') && silent(second) && remindsOf(afterCompact, 'demo') && silent(afterCompactNext);
    report(ok, name, ok ? '' : `first=${show(first)}, second=${show(second)}, afterCompact=${show(afterCompact)}, afterCompactNext=${show(afterCompactNext)}`);
  }
  {
    const name = 'umbrella: git status in a sub-repo counts as its first touch (reminded once, then silent)';
    const tmp = fs.mkdtempSync(path.join(root, 'tmp-'));
    const convo = conversation('chat', false);
    const gitTouch = touch('chat', convo, run('git status --short', repo), home, tmp);
    const nextTouch = touch('chat', convo, run('ls', repo), home, tmp);
    const ok = remindsOf(gitTouch, 'demo') && silent(nextTouch);
    report(ok, name, ok ? '' : `gitTouch=${show(gitTouch)}, nextTouch=${show(nextTouch)}`);
  }
  {
    const name = 'umbrella: fallback to os.tmpdir() when brain dir is missing';
    const tmp = fs.mkdtempSync(path.join(root, 'tmp-'));
    const convo = conversation('chat', false, false);
    const first = touch('chat', convo, run('ls', repo), home, tmp);
    const second = touch('chat', convo, run('pwd', repo), home, tmp);
    const napTmp = path.join(tmp, 'claude-nap-context-repo-con');
    const fellBack = remindsOf(first, 'demo') && silent(second) && fs.existsSync(napTmp);
    report(fellBack, name, fellBack ? '' : `first=${show(first)}, second=${show(second)}, napInTmp=${fs.existsSync(napTmp)}`);
  }
} else {
  console.log(`SKIP  umbrella guard (${NAP ? `${NAP} not found` : 'no napHook in local.json'})`);
}

for (const mode of ['cli', 'chat']) {
  const tmp = fs.mkdtempSync(path.join(root, 'tmp-'));
  const worker = conversation(mode, true);
  bridge(payload(mode, worker, { name: 'run_command', args: { CommandLine: 'ls', Cwd: ws } }), tmp);
  report(storedMode(mode, worker, tmp) === 'worker', `${mode} worker detected`);
  const direct = conversation(mode, false);
  bridge(payload(mode, direct, { name: 'run_command', args: { CommandLine: 'ls', Cwd: ws } }), tmp);
  report(storedMode(mode, direct, tmp) !== 'worker', `${mode} direct session not taken for a worker`);
}

fs.rmSync(root, { recursive: true, force: true });
console.log(failed ? `${failed} case(s) failed` : 'all cases passed');

// Same as payloadShape in ../claude-hook-bridge.cjs.
function payloadShape(p) {
  const keys = (o) => (o && typeof o === 'object' && !Array.isArray(o) ? Object.keys(o).sort().join(',') : '');
  return `${keys(p)}|${keys(p && p.toolCall)}`;
}
// When the installed agy arrived: the newest of the CLI binary and Orca's chat runtime folders.
function installedAt() {
  const times = [];
  try {
    const bin = spawnSync('which', ['agy'], { encoding: 'utf8', timeout: 5000 }).stdout.trim();
    if (bin) times.push(fs.statSync(fs.realpathSync(bin)).mtimeMs);
  } catch (_) { /* no CLI */ }
  try {
    for (const d of fs.readdirSync(RUNTIMES)) if (!d.startsWith('.')) times.push(fs.statSync(path.join(RUNTIMES, d)).mtimeMs);
  } catch (_) { /* no runtime */ }
  return times.length ? Math.max(...times) : 0;
}
let code = failed ? 1 : 0;
if (!failed && require.main === module) {
  const known = new Set(['cli', 'chat'].map((m) => payloadShape(TEMPLATES[m])));
  let seen = {};
  try { seen = JSON.parse(fs.readFileSync(path.join(LOCAL_DIR, 'seen-shapes.json'), 'utf8')); } catch (_) { /* none yet */ }
  const since = installedAt();
  const recent = Object.entries(seen).filter(([, t]) => t >= since).map(([k]) => k);
  const unknown = recent.filter((k) => !known.has(k));
  if (unknown.length) {
    console.log(`FAIL  the installed agy sent payload shapes payloads.json does not replay:\n${unknown.map((k) => `  ${k}`).join('\n')}\n` +
      `  replayed: ${[...known].join(' ; ')}\n  capture one of each and add it to payloads.json`);
    code = 1;
  } else if (!recent.length) {
    console.log('WAIT  no agy payload seen since the installed versions arrived; versions not recorded yet');
    code = 3;
  } else if (!process.env.NAP_HOOK_PATH) {
    fs.writeFileSync(STAMP, JSON.stringify({ ...versions(), at: new Date().toISOString() }, null, 2) + '\n');
  }
}
process.exit(code);
