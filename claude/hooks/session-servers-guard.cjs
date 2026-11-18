#!/usr/bin/env node
/**
 * session-servers-guard.cjs - Stop: a process this session started (it carries
 * CLAUDE_CODE_SESSION_ID=<this session> in its environment) and that a Bash call started itself
 * (`nohup … &`, a background command) that still listens on a TCP port when the turn ends is sent
 * back: stop it if it was only started to check, or say in the reply that Viet asked to keep it
 * (ntv-implement § Change; user-profile.md: nothing runs in the background without asking).
 * Each server is sent back once, remembered by pid and start time in
 * $TMPDIR/session-servers-guard/<session>.json, so a kept server costs no further turns and another
 * Stop hook's send-back (`stop_hook_active`) does not hide a new one.
 * While a background Bash call of this session still runs (a shell sourcing `shell-snapshots`, child
 * of the `claude` process that runs this hook), the check waits: that call may own the listeners (a
 * test that starts and stops its own Postgres), the harness wakes Claude when it ends, and the next
 * Stop checks what is left; a background server ends with its call at the harness timeout.
 * Sees TCP listeners only: a watcher with no port is not caught. Background subagents share the
 * session id, so a server one of them still needs is listed too. Fails open on any error.
 * Giới hạn: trên win32 không đọc được env của process khác nên hook thoát 0 ngay.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const run = (cmd, args) =>
  execFileSync(cmd, args, { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });

// Listening TCP sockets as pid -> {cmd, ports}, from `lsof -F` (p = pid, c = command, n = address).
function listeners() {
  let out = '';
  try { out = run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpcn']); } catch (_) { return new Map(); }
  const map = new Map();
  let pid = null;
  for (const line of out.split('\n')) {
    const [tag, value] = [line[0], line.slice(1)];
    if (tag === 'p') { pid = value; if (!map.has(pid)) map.set(pid, { cmd: '', ports: new Set() }); }
    else if (tag === 'c' && pid) map.get(pid).cmd = value;
    else if (tag === 'n' && pid) map.get(pid).ports.add(value.replace(/^.*:/, ''));
  }
  return map;
}

// True for a server a Bash call started itself: its parent is a shell, or it was orphaned to launchd
// once that shell exited (`nohup … &`). A server a running program spawned (a gate's app on a random
// port) has that program as parent and stops with it.
function startedByShell(pid) {
  try {
    const ppid = run('ps', ['-o', 'ppid=', '-p', pid]).trim();
    if (ppid === '1') return true;
    const parent = path.basename(run('ps', ['-o', 'comm=', '-p', ppid]).trim()).replace(/^-/, '');
    return ['zsh', 'bash', 'sh', 'nohup'].includes(parent);
  } catch (_) { return false; }
}

// True when `rows` (`{pid, ppid, args}` of every process) hold a Bash call of this session still running:
// a `shell-snapshots` shell whose parent is the nearest `claude` ancestor of `self`, and that is not
// itself an ancestor of `self` (the hook's own chain).
function bashTaskRunning(rows, self) {
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  const chain = new Set();
  let claude = null;
  for (let r = byPid.get(self); r && !chain.has(r.pid); r = byPid.get(r.ppid)) {
    chain.add(r.pid);
    if (/(^|[\\/])claude(\s|$)/.test(r.args)) { claude = r.pid; break; }
  }
  if (!claude) return false;
  return rows.some((r) => r.ppid === claude && !chain.has(r.pid) && /shell-snapshots/.test(r.args));
}

function processTable() {
  return run('ps', ['-ax', '-o', 'pid=,ppid=,args=']).split('\n').map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/))
    .filter(Boolean).map((m) => ({ pid: m[1], ppid: m[2], args: m[3] }));
}

module.exports = { bashTaskRunning };
if (require.main !== module || process.platform === 'win32') return;

let raw = '';
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', () => {
  try {
    const { session_id: session } = JSON.parse(raw);
    if (!session) process.exit(0);
    const store = path.join(os.tmpdir(), 'session-servers-guard', `${session}.json`);
    let seen = [];
    try { seen = JSON.parse(fs.readFileSync(store, 'utf8')); } catch (_) { /* first send-back */ }
    const fresh = [];
    const mark = new RegExp(`(?:^|\\s)CLAUDE_CODE_SESSION_ID=${session}(?:\\s|$)`);
    const ours = [];
    for (const [pid, { cmd, ports }] of listeners()) {
      let env = '';
      try { env = run('ps', ['eww', '-o', 'command=', '-p', pid]); } catch (_) { continue; }
      if (!mark.test(env) || !startedByShell(pid)) continue;
      let key = pid;
      try { key = `${pid}@${run('ps', ['-o', 'lstart=', '-p', pid]).trim()}`; } catch (_) { /* pid only */ }
      if (seen.includes(key)) continue;
      fresh.push(key);
      const args = env.split(/\s+\w+=/)[0].trim().slice(0, 120);
      ours.push(`pid ${pid} (${cmd}) cổng ${[...ports].join(',')}: ${args}`);
    }
    if (!ours.length) process.exit(0);
    if (bashTaskRunning(processTable(), String(process.pid))) process.exit(0);
    fs.mkdirSync(path.dirname(store), { recursive: true });
    fs.writeFileSync(store, JSON.stringify([...seen, ...fresh]));
    process.stdout.write(JSON.stringify({
      decision: 'block',
      reason: 'session-servers-guard: phiên này còn tiến trình đang nghe cổng:\n' +
        ours.map((l) => `- ${l}`).join('\n') +
        '\nBật để kiểm thì tắt ngay (kill <pid>) rồi kết thúc lượt. Chỉ giữ khi Viet đã bảo giữ, hoặc đó là app Viet đang chạy trước khối mà Claude vừa bật lại; nói rõ trong câu trả lời.',
    }));
  } catch (_) { /* fail-open */ }
  process.exit(0);
});
