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

// Umbrella sub-repo guard: a copy of the umbrella's real nap-context-repo-con.cjs in a fake umbrella
// above the temp dir. First non-Read touch in a sub-repo denies once (naming AGENTS.md for agy) and
// records that sub-repo so later commands in it pass until compaction; other sub-repos still deny once.
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

  {
    const name = 'umbrella: first command in sub-repo denies once and names AGENTS.md';
    const tmp = fs.mkdtempSync(path.join(root, 'tmp-'));
    const convo = conversation('chat', false);
    const first = bridgeFull(payload('chat', convo, { name: 'run_command', args: { CommandLine: 'ls', Cwd: repo } }, home), tmp);
    const ok = first.decision === 'deny' && /demo[\\/]AGENTS\.md/.test(first.reason) && !/CLAUDE\.md/.test(first.reason) && /read_file/.test(first.reason);
    report(ok, name, ok ? '' : `decision=${first.decision}, reason=${first.reason.slice(0, 120)}`);
  }
  {
    const name = 'umbrella: cli payload.cwd without args.Cwd blocks once then passes';
    const tmp = fs.mkdtempSync(path.join(root, 'tmp-'));
    const convo = conversation('cli', false);
    const cliCtx = { workspacePaths: [os.homedir()], cwd: repo };
    const first = bridgeFull(payload('cli', convo, { id: 'toolu_01', name: 'run_command', args: { CommandLine: 'ls' } }, cliCtx), tmp);
    const second = bridge(payload('cli', convo, { id: 'toolu_02', name: 'run_command', args: { CommandLine: 'pwd' } }, cliCtx), tmp);
    const ok = first.decision === 'deny' && /demo[\\/]AGENTS\.md/.test(first.reason) && second === 'allow';
    report(ok, name, ok ? '' : `first=${first.decision}, second=${second}`);
  }
  {
    const name = 'umbrella: different command in same sub-repo passes (TMPDIR=A -> TMPDIR=B, state in brain) and other sub-repo still denies once';
    const tmpA = fs.mkdtempSync(path.join(root, 'tmp-a-'));
    const tmpB = fs.mkdtempSync(path.join(root, 'tmp-b-'));
    const convo = conversation('chat', false);
    const brainDir = path.join(convo.vars['{ACP}'], 'brain', convo.cid, '.system_generated');
    const first = bridge(payload('chat', convo, { name: 'run_command', args: { CommandLine: 'ls', Cwd: repo } }, home), tmpA);
    const second = bridge(payload('chat', convo, { name: 'run_command', args: { CommandLine: 'pwd', Cwd: repo } }, home), tmpB);
    const otherFirst = bridgeFull(payload('chat', convo, { name: 'run_command', args: { CommandLine: 'ls', Cwd: otherRepo } }, home), tmpB);
    const otherSecond = bridge(payload('chat', convo, { name: 'run_command', args: { CommandLine: 'pwd', Cwd: otherRepo } }, home), tmpB);
    const napBrainState = path.join(brainDir, 'claude-nap-context-repo-con');
    const napTmpA = path.join(tmpA, 'claude-nap-context-repo-con');
    const napTmpB = path.join(tmpB, 'claude-nap-context-repo-con');
    const stateInBrain = fs.existsSync(napBrainState) && !fs.existsSync(napTmpA) && !fs.existsSync(napTmpB);
    const ok = first === 'deny' && second === 'allow' && stateInBrain &&
      otherFirst.decision === 'deny' && /other[\\/]AGENTS\.md/.test(otherFirst.reason) && !/demo/.test(otherFirst.reason) &&
      otherSecond === 'allow';
    report(ok, name, ok ? '' : `first=${first}, second=${second}, stateInBrain=${stateInBrain}, otherFirst=${otherFirst.decision}, otherSecond=${otherSecond}`);
  }
  {
    const name = 'umbrella: after compaction (CHECKPOINT + PreInvocation), sub-repo denies once again';
    const tmp = fs.mkdtempSync(path.join(root, 'tmp-'));
    const convo = conversation('chat', false);
    bridgeFull(payload('chat', convo, undefined, { ...home, toolCall: undefined }), tmp, 'PreInvocation');
    const first = bridge(payload('chat', convo, { name: 'run_command', args: { CommandLine: 'ls', Cwd: repo } }, home), tmp);
    const second = bridge(payload('chat', convo, { name: 'run_command', args: { CommandLine: 'pwd', Cwd: repo } }, home), tmp);
    fs.appendFileSync(convo.transcript, JSON.stringify({ type: 'CHECKPOINT', step_index: 5 }) + '\n');
    bridgeFull(payload('chat', convo, undefined, { ...home, toolCall: undefined }), tmp, 'PreInvocation');
    const afterCompact = bridge(payload('chat', convo, { name: 'run_command', args: { CommandLine: 'ls -a', Cwd: repo } }, home), tmp);
    const afterCompactNext = bridge(payload('chat', convo, { name: 'run_command', args: { CommandLine: 'ls -1', Cwd: repo } }, home), tmp);
    const ok = first === 'deny' && second === 'allow' && afterCompact === 'deny' && afterCompactNext === 'allow';
    report(ok, name, ok ? '' : `first=${first}, second=${second}, afterCompact=${afterCompact}, afterCompactNext=${afterCompactNext}`);
  }
  {
    const name = 'umbrella: git read-only status passes without marking sub-repo loaded';
    const tmp = fs.mkdtempSync(path.join(root, 'tmp-'));
    const convo = conversation('chat', false);
    const gitPass = bridge(payload('chat', convo, { name: 'run_command', args: { CommandLine: 'git status --short', Cwd: repo } }, home), tmp);
    const nextTouch = bridge(payload('chat', convo, { name: 'run_command', args: { CommandLine: 'ls', Cwd: repo } }, home), tmp);
    const ok = gitPass === 'allow' && nextTouch === 'deny';
    report(ok, name, ok ? '' : `gitPass=${gitPass}, nextTouch=${nextTouch}`);
  }
  {
    const name = 'umbrella: fallback to os.tmpdir() when brain dir is missing';
    const tmp = fs.mkdtempSync(path.join(root, 'tmp-'));
    const convo = conversation('chat', false, false);
    const first = bridge(payload('chat', convo, { name: 'run_command', args: { CommandLine: 'ls', Cwd: repo } }, home), tmp);
    const second = bridge(payload('chat', convo, { name: 'run_command', args: { CommandLine: 'pwd', Cwd: repo } }, home), tmp);
    const napTmp = path.join(tmp, 'claude-nap-context-repo-con');
    const fellBack = first === 'deny' && second === 'allow' && fs.existsSync(napTmp);
    report(fellBack, name, fellBack ? '' : `first=${first}, second=${second}, napInTmp=${fs.existsSync(napTmp)}`);
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
