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
  const firstInput = { type: 'USER_INPUT', content: worker ? `${PREAMBLE}\nTask: x` : 'Kiểm pipeline hôm nay' };
  if (mode === 'cli') {
    const brain = path.join(root, 'cli', 'brain', cid);
    fs.mkdirSync(path.join(brain, '.system_generated', 'logs'), { recursive: true });
    fs.writeFileSync(path.join(brain, '.system_generated', 'logs', 'transcript_full.jsonl'), JSON.stringify(firstInput) + '\n');
    return { cid, vars: { '{CLI_BRAIN}': brain, '{CID}': cid, '{WS}': ws } };
  }
  const gh = path.join(root, 'chat');
  const acp = path.join(gh, 'antigravity-acp');
  fs.mkdirSync(path.join(acp, 'conversations'), { recursive: true });
  fs.writeFileSync(path.join(acp, 'conversations', `${cid}.db`), '');
  if (hasBrain) {
    const logs = path.join(acp, 'brain', cid, '.system_generated', 'logs');
    fs.mkdirSync(logs, { recursive: true });
    fs.writeFileSync(path.join(logs, 'transcript.jsonl'), JSON.stringify(firstInput) + '\n');
  }
  fs.mkdirSync(path.join(gh, 'artifacts'), { recursive: true }); // the shared dir Orca names
  return { cid, vars: { '{ACP}': acp, '{GH}': gh, '{CID}': cid, '{WS}': ws } };
}

function payload(mode, convo, toolCall, extra = {}) {
  let text = JSON.stringify(TEMPLATES[mode]);
  for (const [k, v] of Object.entries(convo.vars)) text = text.split(k).join(v);
  return { ...JSON.parse(text), toolCall, ...extra };
}

function bridge(p, tmp) {
  const r = spawnSync('node', [BRIDGE, 'PreToolUse'], {
    input: JSON.stringify(p), encoding: 'utf8', timeout: 20000, env: { ...process.env, TMPDIR: tmp, BRIDGE_FIXTURE: '1' },
  });
  if (r.error || r.status !== 0) return `crash (${r.error ? r.error.message : `exit ${r.status}`})`;
  try { return JSON.parse(r.stdout || '{}').decision || 'allow'; } catch (_) { return 'unparsable output'; }
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
  ['cli read_file Path .env', 'cli', { name: 'read_file', args: { Path: env } }, 'deny', undefined, 'privacy-checker.cjs'],
  ['cli read_file Path README', 'cli', { name: 'read_file', args: { Path: readme } }, 'allow', undefined, 'privacy-checker.cjs'],
  ['cli run_command git status', 'cli', { name: 'run_command', args: { CommandLine: 'git status --short' } }, 'allow'],
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
// above the temp dir. Reading a sub-repo's AGENTS.md from a session whose workspace is outside the
// umbrella (view_file has no Cwd) must count, so a later command in that sub-repo passes.
// Path of an umbrella's nap-context-repo-con.cjs, per machine: local.json `{"napHook": "<abs path>"}`
// (machine-local). Without one, the two umbrella cases are skipped.
const NAP = (() => { try { return JSON.parse(fs.readFileSync(path.join(LOCAL_DIR, 'local.json'), 'utf8')).napHook || ''; } catch (_) { return ''; } })();
if (NAP && fs.existsSync(NAP)) {
  const umbrella = path.join(root, 'umbrella');
  const repo = path.join(umbrella, 'repos', 'systems', 'demo');
  fs.mkdirSync(path.join(umbrella, '.claude', 'hooks'), { recursive: true });
  fs.copyFileSync(NAP, path.join(umbrella, '.claude', 'hooks', 'nap-context-repo-con.cjs'));
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true }); // the hook takes a sub-repo as a folder with .git
  fs.writeFileSync(path.join(repo, 'AGENTS.md'), '# demo\n');
  for (const [name, readFirst, want] of [['umbrella: read AGENTS.md from ~, then ls in sub-repo', true, 'allow'],
    ['umbrella: ls in sub-repo without reading AGENTS.md', false, 'deny']]) {
    const tmp = fs.mkdtempSync(path.join(root, 'tmp-'));
    const convo = conversation('chat', false);
    const home = { workspacePaths: [os.homedir()] };
    if (readFirst) bridge(payload('chat', convo, { name: 'view_file', args: { AbsolutePath: path.join(repo, 'AGENTS.md') } }, home), tmp);
    const got = bridge(payload('chat', convo, { name: 'run_command', args: { CommandLine: 'ls', Cwd: repo } }, home), tmp);
    report(got === want, name, got === want ? '' : `got ${got}, want ${want}`);
  }
  {
    const name = 'umbrella: read AGENTS.md with TMPDIR=A, then ls in sub-repo with TMPDIR=B';
    const tmpA = fs.mkdtempSync(path.join(root, 'tmp-a-'));
    const tmpB = fs.mkdtempSync(path.join(root, 'tmp-b-'));
    const convo = conversation('chat', false);
    const brainDir = path.join(convo.vars['{ACP}'], 'brain', convo.cid, '.system_generated');
    const home = { workspacePaths: [os.homedir()] };
    bridge(payload('chat', convo, { name: 'view_file', args: { AbsolutePath: path.join(repo, 'AGENTS.md') } }, home), tmpA);
    const got = bridge(payload('chat', convo, { name: 'run_command', args: { CommandLine: 'ls', Cwd: repo } }, home), tmpB);
    const napBrainState = path.join(brainDir, 'claude-nap-context-repo-con');
    const napTmpA = path.join(tmpA, 'claude-nap-context-repo-con');
    const napTmpB = path.join(tmpB, 'claude-nap-context-repo-con');
    const stateInBrain = fs.existsSync(napBrainState) && !fs.existsSync(napTmpA) && !fs.existsSync(napTmpB);
    const ok = got === 'allow' && stateInBrain;
    report(ok, name, ok ? '' : `got ${got}, stateInBrain=${stateInBrain}`);
  }
  {
    const name = 'umbrella: fallback to os.tmpdir() when brain dir is missing';
    const tmp = fs.mkdtempSync(path.join(root, 'tmp-'));
    const convo = conversation('chat', false, false);
    const home = { workspacePaths: [os.homedir()] };
    bridge(payload('chat', convo, { name: 'view_file', args: { AbsolutePath: path.join(repo, 'AGENTS.md') } }, home), tmp);
    const got = bridge(payload('chat', convo, { name: 'run_command', args: { CommandLine: 'ls', Cwd: repo } }, home), tmp);
    const napTmp = path.join(tmp, 'claude-nap-context-repo-con');
    const fellBack = got === 'allow' && fs.existsSync(napTmp);
    report(fellBack, name, fellBack ? '' : `got ${got}, napInTmp=${fs.existsSync(napTmp)}`);
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
  } else {
    fs.writeFileSync(STAMP, JSON.stringify({ ...versions(), at: new Date().toISOString() }, null, 2) + '\n');
  }
}
process.exit(code);
