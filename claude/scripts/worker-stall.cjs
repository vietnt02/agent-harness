#!/usr/bin/env node
/**
 * worker-stall.cjs - one line for one Orca worker, in the "<state> [context]" form watch.sh judges:
 *   done <state>     the worker's Task ended (succeeded, failed, stopped, cancelled, abandoned)
 *   running <why>    a file in its worktree changed within --idle-min minutes, and no API error streak
 *   stale <why>      nothing in its worktree changed for --idle-min minutes, or the worker's messages
 *                    since the last run hold >= --api-errors 502/503/429-type errors
 * A worker that is only reading for a long time also shows `stale`: a cue to look (worker-read twice,
 * a few minutes apart), never to stop or rerun it (ntv-orca § 3). Anything it cannot read exits 1 with
 * stderr, never a state line, so watch.sh counts it as an error instead of waiting on it.
 * It reads worker-show, file times in the worktree and worker-read from a cursor kept between runs
 * ($TMPDIR/claude-worker-stall/<dispatch>.json), so each run reads only the messages new since the
 * last one; user messages (the brief, the spec) never count. It never reads `orca orchestration
 * check`, so it takes no message from the coordinator's inbox.
 *
 *   node ~/.claude/scripts/worker-stall.cjs --dispatch <ctx_id> [--idle-min 10] [--api-errors 3]
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const DONE = new Set(['succeeded', 'failed', 'stopped', 'cancelled', 'canceled', 'abandoned', 'completed']);
const API_ERROR = /HTTP[ /0-9.]*\b(502|503|429)\b|\b(502|503|429)[ :-]*(Bad Gateway|Service Unavailable|Too Many Requests)|RESOURCE_EXHAUSTED|\bUNAVAILABLE\b|Bad Gateway|Service Unavailable|Too Many Requests/;
const MAX_PAGES = 40;

function args(argv) {
  const out = { dispatch: '', idle: 10, errors: 3 };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i + 1];
    if (argv[i] === '--dispatch') { out.dispatch = v || ''; i++; } else if (argv[i] === '--idle-min') { out.idle = Number(v); i++; } else if (argv[i] === '--api-errors') { out.errors = Number(v); i++; } else if (argv[i] === '-h' || argv[i] === '--help') { out.help = true; } else { out.bad = argv[i]; }
  }
  return out;
}

const orca = (a) => JSON.parse(execFileSync('orca', a, { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] }));

// The text of the blocks a worker message carries (its words, tool output), never a user message.
function workerText(m) {
  if (!m || m.role === 'user') return '';
  return (m.blocks || []).map((b) => [b.text, typeof b.output === 'string' ? b.output : ''].filter(Boolean).join('\n')).join('\n');
}

// New worker messages since the saved cursor, counted for API errors; the cursor is moved on.
function newErrors(dispatch, read = (a) => orca(a), stateDir = path.join(os.tmpdir(), 'claude-worker-stall')) {
  const file = path.join(stateDir, `${dispatch.replace(/[^\w-]/g, '_')}.json`);
  let state = {};
  try { state = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { /* first run */ }
  let cursor = state.cursor;
  let count = 0;
  // A saved cursor Orca rejects (`source_changed`) is dropped once: the run reads from the start
  // again and only moves the cursor to the end, counting nothing, so old history is not new errors.
  let counting = true;
  for (let page = 0; page < MAX_PAGES; page++) {
    const a = ['orchestration', 'worker-read', '--dispatch', dispatch, '--source', 'transcript', '--limit', '50', '--json'];
    if (cursor) a.push('--cursor', cursor);
    let r;
    try { r = read(a).result || {}; } catch (e) {
      if (!cursor || page > 0 || !counting) throw e;
      cursor = undefined; counting = false; page = -1;
      continue;
    }
    const t = r.transcript || {};
    if (counting) for (const m of t.messages || []) if (API_ERROR.test(workerText(m))) count++;
    if (r.cursor || t.nextCursor) cursor = t.nextCursor || r.cursor;
    if (!t.limited) break;
  }
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ cursor }));
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

function status(o, deps = {}) {
  const show = deps.show || ((d) => orca(['orchestration', 'worker-show', '--dispatch', d, '--json']).result || {});
  const r = show(o.dispatch);
  const state = r.state || 'unknown';
  if (DONE.has(state)) return `done ${state}`;
  const errors = (deps.newErrors || newErrors)(o.dispatch);
  if (errors >= o.errors) return `stale api-errors=${errors} state=${state}`;
  const workspace = String(r.workspace || '').split('::').pop();
  if (!workspace || !fs.existsSync(workspace)) throw new Error(`no worktree on disk for ${o.dispatch} (state=${state})`);
  const recent = changedSince(workspace, (deps.now || Date.now()) - o.idle * 60000);
  return recent ? `running changed=${recent} state=${state}` : `stale idle>${o.idle}m state=${state}`;
}

module.exports = { args, status, newErrors, workerText, changedSince, API_ERROR };
if (require.main !== module) return;

const o = args(process.argv.slice(2));
if (o.help) { process.stdout.write(fs.readFileSync(__filename, 'utf8').split('*/')[0]); process.exit(0); }
if (o.bad || !o.dispatch || !(o.idle > 0) || !(o.errors > 0)) {
  process.stderr.write('usage: worker-stall.cjs --dispatch <ctx_id> [--idle-min <minutes > 0>] [--api-errors <n > 0>]\n');
  process.exit(2);
}
try {
  process.stdout.write(`${status(o)}\n`);
} catch (e) {
  const why = String(e.stderr || '').split('\n').find((l) => l.trim()) || String(e.message).split('\n')[0];
  process.stderr.write(`worker-stall: ${why}\n`);
  process.exit(1);
}
