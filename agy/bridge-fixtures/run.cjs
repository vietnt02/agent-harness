#!/usr/bin/env node
/**
 * Replays real agy hook payloads (payloads.json: agy CLI and Orca's agy chat runtime) through
 * ../claude-hook-bridge.cjs and checks each guard decision and worker detection.
 * Run after any change to the bridge, and whenever agy or Orca's agy runtime changes version:
 *   node ~/.gemini/config/bridge-fixtures/run.cjs
 * A new version can change the payload itself; this only replays the shapes in payloads.json. When
 * a version changes, capture a fresh payload of each kind (a hook that appends stdin to a file) and
 * compare its keys with payloads.json before trusting a green run.
 * Exit 0 when every case passes, 1 otherwise; a pass records the agy versions in tested-versions.json,
 * which worker-start-receipt compares with the installed ones. Otherwise writes only under a temp dir.
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
const RUNTIMES = path.join(os.homedir(), 'Library', 'Application Support', 'orca', 'agent-runtimes', 'antigravity');

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
function conversation(mode, worker) {
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
  const logs = path.join(acp, 'brain', cid, '.system_generated', 'logs');
  fs.mkdirSync(logs, { recursive: true });
  fs.writeFileSync(path.join(logs, 'transcript.jsonl'), JSON.stringify(firstInput) + '\n');
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
    input: JSON.stringify(p), encoding: 'utf8', timeout: 20000, env: { ...process.env, TMPDIR: tmp },
  });
  if (r.error || r.status !== 0) return `crash (${r.error ? r.error.message : `exit ${r.status}`})`;
  try { return JSON.parse(r.stdout || '{}').decision || 'allow'; } catch (_) { return 'unparsable output'; }
}

// Worker mode as the bridge stored it for this conversation, wherever it put it.
function storedMode(mode, convo, tmp) {
  const files = [path.join(tmp, `agy-hook-state-${convo.cid}.json`)];
  if (mode === 'cli') files.push(path.join(convo.vars['{CLI_BRAIN}'], '.system_generated', 'agy-hook-state.json'));
  else files.push(path.join(convo.vars['{GH}'], 'artifacts', '.system_generated', 'agy-hook-state.json'));
  for (const f of files) { try { return JSON.parse(fs.readFileSync(f, 'utf8')).mode || null; } catch (_) { /* next */ } }
  return null;
}

const env = path.join(ws, '.env');
const readme = path.join(ws, 'README.md');
const cases = [
  ['cli read_file Path .env', 'cli', { name: 'read_file', args: { Path: env } }, 'deny'],
  ['cli read_file Path README', 'cli', { name: 'read_file', args: { Path: readme } }, 'allow'],
  ['cli run_command git status', 'cli', { name: 'run_command', args: { CommandLine: 'git status --short' } }, 'allow'],
  ['chat view_file AbsolutePath .env', 'chat', { name: 'view_file', args: { AbsolutePath: env } }, 'deny'],
  ['chat view_file absolute_path .env', 'chat', { name: 'view_file', args: { absolute_path: env } }, 'deny'],
  ['chat view_file absolute_path README', 'chat', { name: 'view_file', args: { absolute_path: readme } }, 'allow'],
  ['chat run_command ls', 'chat', { name: 'run_command', args: { CommandLine: 'ls', Cwd: ws } }, 'allow'],
  ['malformed: empty arg key', 'chat', { name: 'view_file', args: { '': 1, absolute_path: env } }, 'deny'],
  ['malformed: transcriptPath number', 'chat', { name: 'view_file', args: { AbsolutePath: env } }, 'deny', { transcriptPath: 5 }],
];

let failed = 0;
const report = (ok, name, detail) => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`); };

for (const [name, mode, toolCall, want, extra] of cases) {
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
if (!failed && require.main === module) {
  fs.writeFileSync(STAMP, JSON.stringify({ ...versions(), at: new Date().toISOString() }, null, 2) + '\n');
}
process.exit(failed ? 1 : 0);
