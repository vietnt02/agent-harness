#!/usr/bin/env node
'use strict';
/**
 * heavy.cjs - run a heavy command (a build, a full test suite, a dependency install) in one of N
 * slots shared by every agent on this machine, so parallel workers take turns instead of piling
 * their builds into memory at once. A slot, not a load threshold: a wait on "load below X" can stall
 * a lane for hours, a slot frees the moment its command ends. A dev server takes no slot: it runs for
 * the whole task and would hold one until it stops.
 *
 *   node ~/.claude/scripts/heavy.cjs -- <command> [args...]
 *   node ~/.claude/scripts/heavy.cjs -- sh -c '<command> && <command>'   (a compound command, env vars)
 *
 * A slot belongs to a worktree (the git top level of the cwd, else the cwd): a second heavy command
 * from the same worktree joins the slot its first one holds, so a worker's own install and build
 * never wait on each other. A slot is free again when its last holder exits; a holder whose process died
 * (killed, crashed) is dropped at the next look. The command's exit code comes back unchanged (127
 * when it cannot start); a signal sent to this wrapper goes on to the command.
 * On Windows a command that exists only as a .cmd or .bat (npm, pnpm, yarn) runs through cmd.exe,
 * so `-- npm ci` works there as it does elsewhere.
 * A slot only orders work and never stops it: with no usable slot dir (a sandbox that denies it, a
 * read-only home), or after waiting HEAVY_MAX_WAIT seconds (a holder stuck, a test that hangs), the
 * command runs without a slot, with a warning naming who holds them. While it waits, a line every
 * HEAVY_NOTE_EVERY seconds says so, so a waiting command is not taken for a hung one.
 *
 * Env: HEAVY_SLOTS (default 2), HEAVY_SLOTS_DIR (default ~/.cache/agent-harness/heavy-slots),
 *      HEAVY_POLL_MS (default 2000), HEAVY_MAX_WAIT (seconds, default 1200),
 *      HEAVY_NOTE_EVERY (seconds, default 60).
 * State: <dir>/slot-<i>.json = { key, root, holders: [{ pid, since }] }; <dir>/.lock, a short mutex.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');

const argv = process.argv.slice(2);
const sep = argv.indexOf('--');
const cmd = sep >= 0 ? argv.slice(sep + 1) : argv;
if (!cmd.length) {
  process.stderr.write('usage: node heavy.cjs -- <command> [args...]\n');
  process.exit(2);
}

const SLOTS = Math.max(1, parseInt(process.env.HEAVY_SLOTS || '', 10) || 2);
const DIR = process.env.HEAVY_SLOTS_DIR || path.join(os.homedir(), '.cache', 'agent-harness', 'heavy-slots');
const POLL_MS = Math.max(10, parseInt(process.env.HEAVY_POLL_MS || '', 10) || 2000);
const MAX_WAIT_MS = Math.max(1, Number(process.env.HEAVY_MAX_WAIT) || 1200) * 1000;
const NOTE_MS = Math.max(1, Number(process.env.HEAVY_NOTE_EVERY) || 60) * 1000;
const LOCK = path.join(DIR, '.lock');
const LOCK_STALE_MS = 30000;

function topLevel(cwd) {
  try {
    const out = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, stdio: ['ignore', 'pipe', 'ignore'] });
    return out.toString().trim() || cwd;
  } catch (_) {
    return cwd;
  }
}
const ROOT = path.resolve(topLevel(process.cwd()));
const KEY = crypto.createHash('sha1')
  .update(process.platform === 'win32' ? ROOT.toLowerCase() : ROOT).digest('hex').slice(0, 16);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

// Runs fn while holding <dir>/.lock; a lock older than LOCK_STALE_MS belonged to a process that died
// inside this short section, and is taken over.
async function locked(fn) {
  for (;;) {
    try {
      fs.mkdirSync(LOCK);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        if (Date.now() - fs.statSync(LOCK).mtimeMs > LOCK_STALE_MS) fs.rmdirSync(LOCK);
      } catch (_) { /* released meanwhile */ }
      await sleep(20);
    }
  }
  try {
    return fn();
  } finally {
    try { fs.rmdirSync(LOCK); } catch (_) { /* already gone */ }
  }
}

// Written to a temp file then renamed, so a writer killed mid-write never leaves a half file that
// would drop every live holder in it.
function write(file, slot) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(slot));
  fs.renameSync(tmp, file);
}
function drop(file) {
  try { fs.unlinkSync(file); } catch (_) { /* already gone */ }
}

// The slots in use, each with its live holders; a slot left with none is removed. Call inside `locked`.
function inUse() {
  const out = [];
  for (const name of fs.readdirSync(DIR)) {
    const m = /^slot-(\d+)\.json$/.exec(name);
    if (!m) continue;
    const file = path.join(DIR, name);
    let slot = null;
    try { slot = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { /* half-written: treat as free */ }
    const before = slot && Array.isArray(slot.holders) ? slot.holders : [];
    const holders = before.filter((h) => h && Number.isInteger(h.pid) && alive(h.pid));
    if (!holders.length) {
      drop(file);
      continue;
    }
    if (holders.length !== before.length) write(file, { ...slot, holders });
    out.push({ index: Number(m[1]), file, slot: { ...slot, holders } });
  }
  return out;
}

// Joins this worktree's slot, or takes a free one; else returns the roots of the busy slots.
function take() {
  const slots = inUse();
  const me = { pid: process.pid, since: Date.now() };
  const own = slots.find((s) => s.slot.key === KEY);
  if (own) {
    write(own.file, { ...own.slot, holders: [...own.slot.holders, me] });
    return { file: own.file };
  }
  if (slots.length >= SLOTS) return { busy: slots.map((s) => s.slot.root) };
  const used = new Set(slots.map((s) => s.index));
  let index = 0;
  while (used.has(index)) index += 1;
  const file = path.join(DIR, `slot-${index}.json`);
  write(file, { key: KEY, root: ROOT, holders: [me] });
  return { file };
}

function give(file) {
  let slot;
  try { slot = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return; }
  const holders = (slot.holders || []).filter((h) => h && h.pid !== process.pid && alive(h.pid));
  if (holders.length) write(file, { ...slot, holders });
  else drop(file);
}

async function main() {
  let got = null;
  const t0 = Date.now();
  let noted = 0;
  try {
    fs.mkdirSync(DIR, { recursive: true });
    for (;;) {
      got = await locked(take);
      if (got.file) break;
      const waited = Date.now() - t0;
      const held = `${got.busy.length}/${SLOTS} held by: ${got.busy.join(', ')}`;
      if (waited >= MAX_WAIT_MS) {
        process.stderr.write(`heavy: waited ${Math.round(waited / 1000)}s for a slot (${held}); running without a slot\n`);
        got = null;
        break;
      }
      if (!noted) {
        process.stderr.write(`heavy: waiting for a slot (${held})\n`);
        noted = Date.now();
      } else if (Date.now() - noted >= NOTE_MS) {
        process.stderr.write(`heavy: still waiting for a slot after ${Math.round(waited / 1000)}s (${held})\n`);
        noted = Date.now();
      }
      await sleep(POLL_MS);
    }
  } catch (e) {
    process.stderr.write(`heavy: no usable slot dir ${DIR} (${e.code || e.message}); running without a slot\n`);
    got = null;
  }
  let finished = false;
  const finish = async (code) => {
    if (finished) return;
    finished = true;
    if (got && got.file) {
      try { await locked(() => give(got.file)); } catch (_) { /* the next look drops a dead holder */ }
    }
    process.exit(code);
  };
  let child = null;
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => {
      try { if (child) child.kill(sig); } catch (_) { /* already gone */ }
    });
  }
  const start = (viaCmd) => {
    try {
      child = viaCmd ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${cmdLine(cmd)}"`],
        { stdio: 'inherit', windowsVerbatimArguments: true }) : spawn(cmd[0], cmd.slice(1), { stdio: 'inherit' });
    } catch (e) {
      if (!viaCmd && onCmdShim(e)) return start(true);
      process.stderr.write(`heavy: cannot start ${cmd[0]}: ${e.message}\n`);
      return finish(127);
    }
    child.on('error', (e) => {
      if (!viaCmd && onCmdShim(e)) return start(true);
      process.stderr.write(`heavy: cannot start ${cmd[0]}: ${e.message}\n`);
      return finish(127);
    });
    child.on('exit', (code, signal) => {
      // cmd.exe answers a name it cannot find with 9009: the same "cannot start" as 127 elsewhere.
      if (viaCmd && code === 9009) return finish(127);
      return finish(code === null ? 128 + (os.constants.signals[signal] || 1) : code);
    });
    return undefined;
  };
  start(false);
}

// Windows starts only .exe files directly: a bare name that failed (npm is npm.cmd) is retried through
// cmd.exe, which finds .cmd and .bat on PATH.
function onCmdShim(e) {
  return process.platform === 'win32' && (e.code === 'ENOENT' || e.code === 'EINVAL') && !/[\\/]/.test(cmd[0]);
}
// One cmd.exe command line; an argument holding spaces or cmd metacharacters is quoted.
function cmdLine(words) {
  return words.map((w) => (/^[\w.,:=@%+\/\\-]+$/.test(w) ? w : `"${String(w).replace(/"/g, '""')}"`)).join(' ');
}

main().catch((e) => {
  process.stderr.write(`heavy: ${e.message}\n`);
  process.exit(1);
});
