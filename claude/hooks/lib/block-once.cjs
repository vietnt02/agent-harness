'use strict';
/**
 * block-once.cjs - a nudge before a command runs. PreToolUse context reaches the model only after the
 * command ran, so a reminder that must land first is a block; but it is said once: the same command
 * run again within TTL_MS passes. A guard that uses it guides, it does not wall off.
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TTL_MS = 10 * 60 * 1000;
const DIR = path.join(os.tmpdir(), 'claude-block-once');

// True the first time this session runs `command` under `hook` (block it with the reminder); false
// when it ran within TTL_MS already (let it through). No session id: always true, as before.
function firstTime(sessionId, hook, command, now = Date.now()) {
  if (!sessionId) return true;
  const file = path.join(DIR, `${String(sessionId).replace(/[^\w-]/g, '_')}.json`);
  const key = crypto.createHash('sha1').update(`${hook}\0${String(command).trim()}`).digest('hex').slice(0, 16);
  let seen = {};
  try { seen = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first time */ }
  const was = seen[key];
  seen[key] = now;
  for (const [k, t] of Object.entries(seen)) if (now - t > TTL_MS) delete seen[k];
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(seen));
  } catch { /* not remembered: the next run is blocked once more */ }
  return !(was && now - was <= TTL_MS);
}

const AGAIN = ' Said once: if the command is right as it is, run it again unchanged and it passes.';

module.exports = { firstTime, AGAIN, TTL_MS };
