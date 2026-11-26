'use strict';
/**
 * heavy.cjs: heavy commands from different worktrees take turns in N shared slots; commands from one
 * worktree share its slot; a slot whose holder died is taken back; the command's exit code comes back
 * unchanged, and a stopped wrapper stops its command and frees the slot. Every run uses a temp slot
 * dir and a temp log, never the machine's real ones.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'claude', 'scripts', 'heavy.cjs');
const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A child that records its start and end (ms) in <log>/<name>.json after holding for `ms`.
const hold = (log, name, ms) => [process.execPath, '-e',
  `const fs=require('fs');const s=Date.now();setTimeout(function(){fs.writeFileSync(${JSON.stringify(path.join(log, `${name}.json`))},JSON.stringify({s:s,e:Date.now()}))},${ms})`];
// A child that writes its pid to <file>, then waits long enough to be killed.
const linger = (file) => [process.execPath, '-e',
  `require('fs').writeFileSync(${JSON.stringify(file)},String(process.pid));setTimeout(function(){},60000)`];

// Every run logs into this temp file unless a test names its own: never the real log.
const TEST_LOG = path.join(tmp('heavy-testlog-'), 'heavy-log.jsonl');
function run(cwd, slotsDir, slots, cmd, env = {}) {
  return spawn(process.execPath, [SCRIPT, '--', ...cmd], {
    cwd,
    env: { ...process.env, HEAVY_SLOTS_DIR: slotsDir, HEAVY_SLOTS: String(slots), HEAVY_POLL_MS: '50', HEAVY_LOG: TEST_LOG, ...env },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
}
const stderrOf = (child) => {
  let err = '';
  child.stderr.on('data', (d) => { err += d; });
  return () => err;
};
const done = (child) => new Promise((resolve) => child.on('close', (code, signal) => resolve({ code, signal })));
const span = (log, name) => JSON.parse(fs.readFileSync(path.join(log, `${name}.json`), 'utf8'));
const overlap = (a, b) => a.s < b.e && b.s < a.e;
const slotFiles = (dir) => fs.readdirSync(dir).filter((f) => f.startsWith('slot-'));
async function waitFor(file, ms = 10000) {
  const end = Date.now() + ms;
  while (!fs.existsSync(file)) {
    if (Date.now() > end) throw new Error(`${file} never appeared`);
    await sleep(25);
  }
  return Number(fs.readFileSync(file, 'utf8'));
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

test('one slot: commands from two worktrees run one after the other', { timeout: 20000 }, async () => {
  const slots = tmp('heavy-slots-');
  const log = tmp('heavy-log-');
  const a = run(tmp('heavy-wt-a-'), slots, 1, hold(log, 'a', 400));
  const b = run(tmp('heavy-wt-b-'), slots, 1, hold(log, 'b', 400));
  const [ra, rb] = await Promise.all([done(a), done(b)]);
  assert.deepEqual([ra.code, rb.code], [0, 0]);
  assert.equal(overlap(span(log, 'a'), span(log, 'b')), false);
  assert.deepEqual(slotFiles(slots), []);
});

test('two slots: commands from two worktrees run together', { timeout: 20000 }, async () => {
  const slots = tmp('heavy-slots-');
  const log = tmp('heavy-log-');
  const a = run(tmp('heavy-wt-a-'), slots, 2, hold(log, 'a', 1500));
  const b = run(tmp('heavy-wt-b-'), slots, 2, hold(log, 'b', 1500));
  await Promise.all([done(a), done(b)]);
  assert.equal(overlap(span(log, 'a'), span(log, 'b')), true);
  assert.deepEqual(slotFiles(slots), []);
});

test('two slots: a third worktree waits until one of them ends', { timeout: 20000 }, async () => {
  const slots = tmp('heavy-slots-');
  const log = tmp('heavy-log-');
  const a = run(tmp('heavy-wt-a-'), slots, 2, hold(log, 'a', 1500));
  const b = run(tmp('heavy-wt-b-'), slots, 2, hold(log, 'b', 1500));
  await sleep(500);
  const c = run(tmp('heavy-wt-c-'), slots, 2, hold(log, 'c', 50));
  await Promise.all([done(a), done(b), done(c)]);
  const [sa, sb, sc] = ['a', 'b', 'c'].map((n) => span(log, n));
  assert.ok(sc.s >= Math.min(sa.e, sb.e), 'a third command ran while both slots were held');
  assert.deepEqual(slotFiles(slots), []);
});

test('one worktree shares its slot: its second heavy command does not wait', { timeout: 20000 }, async () => {
  const slots = tmp('heavy-slots-');
  const log = tmp('heavy-log-');
  const wt = tmp('heavy-wt-');
  const a = run(wt, slots, 1, hold(log, 'a', 1500));
  const b = run(wt, slots, 1, hold(log, 'b', 1500));
  await Promise.all([done(a), done(b)]);
  assert.equal(overlap(span(log, 'a'), span(log, 'b')), true);
  assert.deepEqual(slotFiles(slots), []);
});

test('a slot whose holder was killed is taken back', { timeout: 20000 }, async () => {
  const slots = tmp('heavy-slots-');
  const log = tmp('heavy-log-');
  const pidFile = path.join(log, 'child.pid');
  const a = run(tmp('heavy-wt-a-'), slots, 1, linger(pidFile));
  const childPid = await waitFor(pidFile);
  // 'exit', not 'close': the command still holds the killed wrapper's stderr pipe until it is killed too.
  const aExit = new Promise((resolve) => a.on('exit', resolve));
  a.kill('SIGKILL');
  await aExit;
  // On Windows the command dies with its wrapper (libuv's job object); elsewhere it outlives it.
  try { process.kill(childPid, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') throw e; }
  assert.equal(slotFiles(slots).length, 1, 'the killed wrapper left its slot behind');
  const t0 = Date.now();
  const r = await done(run(tmp('heavy-wt-b-'), slots, 1, hold(log, 'b', 50)));
  assert.equal(r.code, 0);
  assert.ok(Date.now() - t0 < 5000, 'the dead holder kept the slot');
  assert.deepEqual(slotFiles(slots), []);
});

test('a fresh lock is waited for; one left by a dead process is taken over', { timeout: 20000 }, async () => {
  const slots = tmp('heavy-slots-');
  const log = tmp('heavy-log-');
  const lock = path.join(slots, '.lock');
  fs.mkdirSync(lock);
  const a = run(tmp('heavy-wt-'), slots, 1, hold(log, 'a', 50));
  await sleep(600);
  assert.equal(fs.existsSync(path.join(log, 'a.json')), false, 'it ran while another process held the lock');
  fs.rmdirSync(lock);
  assert.equal((await done(a)).code, 0);
  fs.mkdirSync(lock);
  const old = (Date.now() - 60000) / 1000;
  fs.utimesSync(lock, old, old);
  const t0 = Date.now();
  assert.equal((await done(run(tmp('heavy-wt-'), slots, 1, hold(log, 'b', 50)))).code, 0);
  assert.ok(Date.now() - t0 < 5000, 'a stale lock was waited on');
});

test("the command's exit code comes back and its slot is freed", { timeout: 20000 }, async () => {
  const slots = tmp('heavy-slots-');
  const r = await done(run(tmp('heavy-wt-'), slots, 1, [process.execPath, '-e', 'process.exit(3)']));
  assert.equal(r.code, 3);
  assert.deepEqual(slotFiles(slots), []);
});

test('no usable slot dir: the command still runs, without a slot', { timeout: 20000 }, async () => {
  const file = path.join(tmp('heavy-ro-'), 'not-a-dir');
  fs.writeFileSync(file, '');
  const child = spawn(process.execPath, [SCRIPT, '--', process.execPath, '-e', 'process.exit(4)'], {
    cwd: tmp('heavy-wt-'),
    env: { ...process.env, HEAVY_SLOTS_DIR: path.join(file, 'slots'), HEAVY_SLOTS: '1', HEAVY_POLL_MS: '50', HEAVY_LOG: TEST_LOG },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let err = '';
  child.stderr.on('data', (d) => { err += d; });
  const r = await done(child);
  assert.equal(r.code, 4);
  assert.match(err, /running without a slot/);
});

test('a waiter gives up after HEAVY_MAX_WAIT and runs without a slot', { timeout: 20000 }, async () => {
  const slots = tmp('heavy-slots-');
  const log = tmp('heavy-log-');
  const a = run(tmp('heavy-wt-a-'), slots, 1, hold(log, 'a', 4000));
  await sleep(500);
  const b = run(tmp('heavy-wt-b-'), slots, 1, hold(log, 'b', 50), { HEAVY_MAX_WAIT: '1' });
  const err = stderrOf(b);
  const rb = await done(b);
  await done(a);
  assert.equal(rb.code, 0);
  assert.ok(span(log, 'b').s < span(log, 'a').e, 'it kept waiting past HEAVY_MAX_WAIT');
  assert.match(err(), /running without a slot/);
  assert.deepEqual(slotFiles(slots), []);
});

test('a waiter says it is still waiting every HEAVY_NOTE_EVERY seconds, naming the holder', { timeout: 20000 }, async () => {
  const slots = tmp('heavy-slots-');
  const log = tmp('heavy-log-');
  const holder = tmp('heavy-wt-holder-');
  const a = run(holder, slots, 1, hold(log, 'a', 2600));
  await sleep(300);
  const b = run(tmp('heavy-wt-b-'), slots, 1, hold(log, 'b', 50), { HEAVY_NOTE_EVERY: '1' });
  const err = stderrOf(b);
  await Promise.all([done(a), done(b)]);
  const notes = err().split('\n').filter((l) => /still waiting/.test(l));
  assert.ok(notes.length >= 1, `no "still waiting" line in:\n${err()}`);
  assert.ok(notes.every((l) => l.includes(path.basename(holder))), 'a note does not name the holder');
});

test('npm runs through it as named, on every platform', { timeout: 60000 }, async () => {
  const slots = tmp('heavy-slots-');
  const child = spawn(process.execPath, [SCRIPT, '--', 'npm', '--version'], {
    cwd: tmp('heavy-wt-'),
    env: { ...process.env, HEAVY_SLOTS_DIR: slots, HEAVY_SLOTS: '1', HEAVY_POLL_MS: '50', HEAVY_LOG: TEST_LOG },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  const r = await done(child);
  assert.equal(r.code, 0, `npm --version exited ${r.code}`);
  assert.match(out.trim(), /^\d+\.\d+\.\d+/);
  assert.deepEqual(slotFiles(slots), []);
});

const readLog = (file) => fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

test('each heavy command leaves one log line with its numbers', { timeout: 20000 }, async () => {
  const slots = tmp('heavy-slots-');
  const log = path.join(tmp('heavy-logdir-'), 'heavy-log.jsonl');
  const r = await done(run(tmp('heavy-wt-'), slots, 1, [process.execPath, '-e', 'setTimeout(function(){}, 300)'], { HEAVY_LOG: log }));
  assert.equal(r.code, 0);
  const lines = readLog(log);
  assert.equal(lines.length, 1);
  const x = lines[0];
  assert.equal(x.cmd, 'node');
  assert.equal(x.slot, true);
  assert.equal(x.reason, null);
  assert.equal(x.exit, 0);
  assert.ok(x.durationMs >= 250, `durationMs ${x.durationMs}`);
  assert.equal(typeof x.waitedMs, 'number');
  assert.equal(typeof x.freePct, 'number');
  assert.ok(typeof x.at === 'string' && !Number.isNaN(Date.parse(x.at)));
  if (process.platform === 'darwin') {
    for (const k of ['pressureArrive', 'pressureStart', 'pressureEnd']) assert.equal(typeof x[k], 'number', k);
  }
});

test('the log keeps a build tool\'s subcommand words but never an argument', { timeout: 60000 }, async () => {
  const log = path.join(tmp('heavy-logdir-'), 'heavy-log.jsonl');
  const pkg = tmp('heavy-pkg-');
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'p', version: '1.0.0', private: true, scripts: { build: 'node -e 0' } }));
  const slots = tmp('heavy-slots-');
  await done(run(tmp('heavy-wt-'), slots, 1, [process.execPath, 'secret-token-123'], { HEAVY_LOG: log }));
  // A plain lowercase word after a program that is no build tool (a client name, a password) is an argument too.
  await done(run(tmp('heavy-wt-'), slots, 1, [process.execPath, 'acmeclient'], { HEAVY_LOG: log }));
  await done(run(pkg, slots, 1, ['npm', 'run', 'build'], { HEAVY_LOG: log }));
  await done(run(pkg, slots, 1, ['npm', 'run', 'Ghp9secret'], { HEAVY_LOG: log }));
  assert.deepEqual(readLog(log).map((x) => x.cmd), ['node', 'node', 'npm run build', 'npm run']);
  assert.ok(!/secret|acmeclient/i.test(fs.readFileSync(log, 'utf8')), 'an argument reached the log');
});

test('the log names a run that gave up waiting, and one killed while waiting', { timeout: 20000 }, async () => {
  const slots = tmp('heavy-slots-');
  const log = path.join(tmp('heavy-logdir-'), 'heavy-log.jsonl');
  const hold = run(tmp('heavy-wt-a-'), slots, 1, [process.execPath, '-e', 'setTimeout(function(){}, 4000)']);
  await sleep(400);
  const gaveUp = await done(run(tmp('heavy-wt-b-'), slots, 1, [process.execPath, '-e', '0'], { HEAVY_LOG: log, HEAVY_MAX_WAIT: '1' }));
  assert.equal(gaveUp.code, 0);
  if (process.platform !== 'win32') {
    const waiter = run(tmp('heavy-wt-c-'), slots, 1, [process.execPath, '-e', '0'], { HEAVY_LOG: log });
    await sleep(600);
    waiter.kill('SIGTERM');
    assert.equal((await done(waiter)).code, 128 + os.constants.signals.SIGTERM);
  }
  await done(hold);
  const lines = readLog(log);
  assert.equal(lines[0].reason, 'max-wait');
  assert.equal(lines[0].slot, false);
  if (process.platform !== 'win32') {
    assert.equal(lines[1].reason, 'killed-waiting');
    assert.equal(lines[1].exit, 128 + os.constants.signals.SIGTERM);
  }
});

test('the log says why a command ran without a slot', { timeout: 20000 }, async () => {
  const file = path.join(tmp('heavy-ro-'), 'not-a-dir');
  fs.writeFileSync(file, '');
  const log = path.join(tmp('heavy-logdir-'), 'heavy-log.jsonl');
  const r = await done(run(tmp('heavy-wt-'), path.join(file, 'slots'), 1, [process.execPath, '-e', '0'], { HEAVY_LOG: log }));
  assert.equal(r.code, 0);
  const [x] = readLog(log);
  assert.equal(x.slot, false);
  assert.equal(x.reason, 'no-dir');
});

test('a log that cannot be written changes nothing for the command', { timeout: 20000 }, async () => {
  const file = path.join(tmp('heavy-ro-'), 'not-a-dir');
  fs.writeFileSync(file, '');
  const r = await done(run(tmp('heavy-wt-'), tmp('heavy-slots-'), 1, [process.execPath, '-e', 'process.exit(3)'],
    { HEAVY_LOG: path.join(file, 'heavy-log.jsonl') }));
  assert.equal(r.code, 3);
});

test('the log turns over past HEAVY_LOG_MAX_BYTES, keeping one old file', { timeout: 20000 }, async () => {
  const dir = tmp('heavy-logdir-');
  const log = path.join(dir, 'heavy-log.jsonl');
  for (const round of [1, 2]) {
    fs.writeFileSync(log, `${round}`.repeat(2000) + '\n');
    const r = await done(run(tmp('heavy-wt-'), tmp('heavy-slots-'), 1, [process.execPath, '-e', '0'],
      { HEAVY_LOG: log, HEAVY_LOG_MAX_BYTES: '1000' }));
    assert.equal(r.code, 0);
    assert.equal(readLog(log).length, 1);
    assert.ok(fs.readFileSync(`${log}.1`, 'utf8').startsWith(`${round}`), `round ${round}: the old file is not the latest`);
  }
  assert.deepEqual(fs.readdirSync(dir).sort(), ['heavy-log.jsonl', 'heavy-log.jsonl.1']);
});

test('a command that cannot even be spawned is logged with its exit, not as killed while waiting', { timeout: 20000 }, async () => {
  const log = path.join(tmp('heavy-logdir-'), 'heavy-log.jsonl');
  const r = await done(run(tmp('heavy-wt-'), tmp('heavy-slots-'), 1, [''], { HEAVY_LOG: log }));
  assert.equal(r.code, 127);
  const [x] = readLog(log);
  assert.equal(x.exit, 127);
  assert.equal(x.reason, null);
});

test('a missing command fails with 127 and frees its slot', { timeout: 20000 }, async () => {
  const slots = tmp('heavy-slots-');
  const r = await done(run(tmp('heavy-wt-'), slots, 1, ['heavy-no-such-command-x']));
  assert.equal(r.code, 127);
  assert.deepEqual(slotFiles(slots), []);
});

test('a stopped wrapper stops its command and frees the slot', { timeout: 20000, skip: process.platform === 'win32' && 'POSIX signals' }, async () => {
  const slots = tmp('heavy-slots-');
  const log = tmp('heavy-log-');
  const pidFile = path.join(log, 'child.pid');
  const a = run(tmp('heavy-wt-'), slots, 1, linger(pidFile));
  const childPid = await waitFor(pidFile);
  const aDone = done(a);
  a.kill('SIGTERM');
  const r = await aDone;
  assert.equal(r.code, 128 + os.constants.signals.SIGTERM);
  await sleep(100);
  assert.equal(alive(childPid), false, 'the command outlived its wrapper');
  assert.deepEqual(slotFiles(slots), []);
});
