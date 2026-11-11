#!/usr/bin/env node
/**
 * worker-stall.cjs - one line for one Orca worker, in the "<state> [context]" form watch.sh judges:
 *   done <state>     the worker's Task ended (succeeded, failed, stopped, cancelled, abandoned)
 *   running <why>    a file in its worktree changed within --idle-min minutes, and no API error streak;
 *                    or `waiting-coordinator`: its last `orca orchestration ask` has no reply yet, for
 *                    at most --ask-max minutes (then `stale ask-unanswered>…`)
 *   stale <why>      nothing in its worktree changed for --idle-min minutes, or the worker's messages
 *                    since the last run hold >= --api-errors 502/503/429-type errors
 * A worker that is only reading for a long time also shows `stale`: a cue to look (worker-read twice,
 * a few minutes apart), never to stop or rerun it (ntv-orca § 3). An agy worker run in a terminal has
 * no Orca transcript: no error count then, and the line adds `agy-step=<n>m`, the age of the last
 * write to its own conversation DB (the newest one naming its worktree), so a long read shows. Anything it cannot read exits 1 with
 * stderr, never a state line, so watch.sh counts it as an error instead of waiting on it.
 * It reads worker-show, file times in the worktree and worker-read from a cursor kept between runs
 * ($TMPDIR/claude-worker-stall/<dispatch>.json), so each run reads only the messages new since the
 * last one; user messages (the brief, the spec) never count. It never reads `orca orchestration
 * check`, so it takes no message from the coordinator's inbox.
 *
 *   node ~/.claude/scripts/worker-stall.cjs --dispatch <ctx_id> [--idle-min 10] [--api-errors 3] [--ask-max 60]
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const DONE = new Set(['succeeded', 'failed', 'stopped', 'cancelled', 'canceled', 'abandoned', 'completed']);
const API_ERROR = /HTTP[ /0-9.]*\b(502|503|429)\b|\b(502|503|429)[ :-]*(Bad Gateway|Service Unavailable|Too Many Requests)|RESOURCE_EXHAUSTED|\bUNAVAILABLE\b|Bad Gateway|Service Unavailable|Too Many Requests/;
const MAX_PAGES = 40;
// What Orca prints for a sent ask, in the worker's tool output: `Question msg_<id> sent.`
const ASK_SENT = /\bQuestion msg_\w+ sent\b/;
// What Orca says when a dispatch has no structured transcript (an agy worker run in a terminal).
const NO_TRANSCRIPT = /transcript_required|provider_unsupported|session_not_reported/;
const AGY_CONVERSATIONS = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'conversations');

function args(argv) {
  const out = { dispatch: '', idle: 10, errors: 3, askMax: 60 };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i + 1];
    if (argv[i] === '--dispatch') { out.dispatch = v || ''; i++; } else if (argv[i] === '--idle-min') { out.idle = Number(v); i++; } else if (argv[i] === '--api-errors') { out.errors = Number(v); i++; } else if (argv[i] === '--ask-max') { out.askMax = Number(v); i++; } else if (argv[i] === '-h' || argv[i] === '--help') { out.help = true; } else { out.bad = argv[i]; }
  }
  return out;
}

const orca = (a) => JSON.parse(execFileSync('orca', a, { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] }));

// The text of the blocks a worker message carries (its words, tool output), never a user message.
function workerText(m) {
  if (!m || m.role === 'user') return '';
  return (m.blocks || []).map((b) => [b.text, typeof b.output === 'string' ? b.output : ''].filter(Boolean).join('\n')).join('\n');
}

// New worker messages since the saved cursor, counted for API errors; the cursor is moved on. The
// state also keeps whether the worker is waiting on its ask: an ask sent, and no message from the
// coordinator's side (a user message) after it.
function newErrors(dispatch, read = (a) => orca(a), stateDir = path.join(os.tmpdir(), 'claude-worker-stall')) {
  const file = path.join(stateDir, `${dispatch.replace(/[^\w-]/g, '_')}.json`);
  let state = {};
  try { state = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { /* first run */ }
  let cursor = state.cursor;
  let count = 0;
  // Orca rejects a cursor (`source_changed`) once the transcript's source identity moves, which a
  // working worker does between pages too: the run then reads from the start again, once. From a
  // saved cursor it keeps what it counted and only moves the cursor to the end, counting nothing
  // more, so old history is not new errors; a first run counts again from zero. A second rejection
  // ends the run with what it counted: a busy worker must not turn the watch into an error.
  let counting = true;
  let reset = false;
  let waiting = state.waiting || false; // false, or the time the ask was first seen
  for (let page = 0; page < MAX_PAGES; page++) {
    const a = ['orchestration', 'worker-read', '--dispatch', dispatch, '--source', 'transcript', '--limit', '50', '--json'];
    if (cursor) a.push('--cursor', cursor);
    let r;
    try { r = read(a).result || {}; } catch (e) {
      if (!cursor || !/source_changed/.test(`${e.stderr || ''}${e.message || ''}`)) throw e;
      if (reset) break;
      reset = true; counting = !state.cursor; if (counting) count = 0; cursor = undefined; page = -1; waiting = false;
      continue;
    }
    const t = r.transcript || {};
    const msgs = t.messages || [];
    if (counting) for (const m of msgs) if (API_ERROR.test(workerText(m))) count++;
    for (const m of msgs) {
      if (m && m.role === 'user') waiting = false;
      else if (ASK_SENT.test(workerText(m))) waiting = waiting || Number(m.timestamp) || Date.now();
    }
    const next = t.nextCursor || r.cursor;
    // `limited` stays true on the last page when Orca clipped oversized text: an empty page or a
    // cursor that did not move is the end.
    const moved = next && next !== cursor;
    if (next) cursor = next;
    if (!t.limited || !msgs.length || !moved) break;
  }
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ cursor, waiting }));
  return count;
}

// The newest file time under `dir` (no .git, node_modules), stopping early once one is recent.
function changedSince(dir, sinceMs) {
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { continue; }
    for (const e of entries) {
      if (e.name === '.git' || e.name === 'node_modules') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) { try { if (fs.statSync(p).mtimeMs >= sinceMs) return path.relative(dir, p); } catch (_) { /* gone */ } }
    }
  }
  return null;
}

// Last write (ms) to the newest agy conversation DB whose trajectory metadata names `workspace`, or
// null. The DB runs in WAL mode, so a -wal file with content holds the latest steps; an empty one is
// what any reader's open leaves behind once agy has closed the DB, so it says nothing. A path continued
// by another path character (`<workspace>-2`) is another worktree. A DB last written before the
// worktree was created cannot be its worker's, so the newest-first scan stops there and costs only
// the conversations since then.
function agyLastStep(workspace, dir = AGY_CONVERSATIONS) {
  let DatabaseSync;
  try { ({ DatabaseSync } = require('node:sqlite')); } catch (_) { return null; }
  const mtime = (p, emptyCounts = true) => { try { const st = fs.statSync(p); return emptyCounts || st.size > 0 ? st.mtimeMs : 0; } catch (_) { return 0; } };
  let born = 0;
  try { born = fs.statSync(workspace).birthtimeMs || 0; } catch (_) { /* no birth time: scan all */ }
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.db')); } catch (_) { return null; }
  const dbs = files.map((f) => path.join(dir, f)).map((p) => ({ p, m: Math.max(mtime(p), mtime(`${p}-wal`, false)) })).sort((a, b) => b.m - a.m);
  const needle = Buffer.from(workspace);
  const names = (buf) => {
    for (let i = buf.indexOf(needle); i >= 0; i = buf.indexOf(needle, i + 1)) {
      if (!/[\w./-]/.test(String.fromCharCode(buf[i + needle.length] ?? 0))) return true;
    }
    return false;
  };
  for (const { p, m } of dbs) {
    if (m < born) break;
    let db;
    try {
      db = new DatabaseSync(p, { readOnly: true });
      if (db.prepare('SELECT data FROM trajectory_metadata_blob').all().some((r) => r.data && names(Buffer.from(r.data)))) return m;
    } catch (_) { /* locked or another schema: not this worker's */ } finally { try { db?.close(); } catch (_) { /* closed */ } }
  }
  return null;
}

// Since when the last newErrors run saw the worker waiting on its ask (ms), or false.
function waitingAsk(dispatch, stateDir = path.join(os.tmpdir(), 'claude-worker-stall')) {
  try { return Number(JSON.parse(fs.readFileSync(path.join(stateDir, `${dispatch.replace(/[^\w-]/g, '_')}.json`), 'utf8')).waiting) || false; } catch (_) { return false; }
}

function status(o, deps = {}) {
  const show = deps.show || ((d) => orca(['orchestration', 'worker-show', '--dispatch', d, '--json']).result || {});
  const r = show(o.dispatch);
  const state = r.state || 'unknown';
  if (DONE.has(state)) return `done ${state}`;
  let errors = 0;
  let terminal = false;
  try { errors = (deps.newErrors || newErrors)(o.dispatch); } catch (e) {
    if (!NO_TRANSCRIPT.test(`${e.stderr || ''}${e.message || ''}`)) throw e;
    terminal = true;
  }
  if (errors >= o.errors) return `stale api-errors=${errors} state=${state}`;
  const workspace = String(r.workspace || '').split('::').pop();
  if (!workspace || !fs.existsSync(workspace)) throw new Error(`no worktree on disk for ${o.dispatch} (state=${state})`);
  const now = deps.now || Date.now();
  let step = '';
  if (terminal) {
    const last = (deps.agyLastStep || agyLastStep)(workspace);
    step = last ? ` agy-step=${Math.max(0, Math.floor((now - last) / 60000))}m` : ' agy-step=none';
  }
  const since = (deps.waitingAsk || waitingAsk)(o.dispatch);
  if (since) {
    const mins = Math.floor(((deps.now || Date.now()) - since) / 60000);
    const max = o.askMax || 60;
    return mins >= max ? `stale ask-unanswered>${max}m state=${state}` : `running waiting-coordinator ${mins}m state=${state}`;
  }
  const recent = changedSince(workspace, now - o.idle * 60000);
  return recent ? `running changed=${recent}${step} state=${state}` : `stale idle>${o.idle}m${step} state=${state}`;
}

module.exports = { args, status, newErrors, waitingAsk, workerText, changedSince, agyLastStep, API_ERROR, ASK_SENT };
if (require.main !== module) return;

const o = args(process.argv.slice(2));
if (o.help) { process.stdout.write(fs.readFileSync(__filename, 'utf8').split('*/')[0]); process.exit(0); }
if (o.bad || !o.dispatch || !(o.idle > 0) || !(o.errors > 0) || !(o.askMax > 0)) {
  process.stderr.write('usage: worker-stall.cjs --dispatch <ctx_id> [--idle-min <minutes > 0>] [--api-errors <n > 0>] [--ask-max <minutes > 0>]\n');
  process.exit(2);
}
try {
  process.stdout.write(`${status(o)}\n`);
} catch (e) {
  const why = String(e.stderr || '').split('\n').find((l) => l.trim()) || String(e.message).split('\n')[0];
  process.stderr.write(`worker-stall: ${why}\n`);
  process.exit(1);
}
