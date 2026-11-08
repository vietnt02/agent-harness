'use strict';
/**
 * block-once.cjs - a nudge before a command runs. PreToolUse context reaches the model only after the
 * command ran, so a reminder that must land first is a block; but it is said once: the same command
 * run again within TTL_MS passes. For process only: what reaches others or cannot be undone keeps a
 * hard block. One file per session and hook, written whole (temp + rename), since hooks on one call run
 * in parallel.
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TTL_MS = 10 * 60 * 1000;
const DIR = path.join(os.tmpdir(), 'claude-block-once');
const safe = (s) => String(s).replace(/[^\w-]/g, '_');

// True the first time this session runs `command` under `hook` (block it with the reminder); false
// when it ran within TTL_MS already (let it through). No session id: always true, as before.
function firstTime(sessionId, hook, command, now = Date.now()) {
  if (!sessionId) return true;
  const file = path.join(DIR, `${safe(sessionId)}.${safe(hook)}.json`);
  const key = crypto.createHash('sha1').update(String(command).trim()).digest('hex').slice(0, 16);
  let seen = {};
  try { seen = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first time */ }
  const was = seen[key];
  seen[key] = now;
  for (const [k, t] of Object.entries(seen)) if (now - t > TTL_MS) delete seen[k];
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}`;
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(seen));
    fs.renameSync(tmp, file);
  } catch {
    try { fs.rmSync(tmp, { force: true }); } catch { /* nothing left */ }
  }
  return !(was && now - was <= TTL_MS);
}

// The line that tells the model a rerun passes; empty when there is no session to remember it by.
const again = (sessionId) => (sessionId ? ' Said once: if the command is right as it is, run it again unchanged and it passes.' : '');

module.exports = { firstTime, again, TTL_MS };
