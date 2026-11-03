#!/usr/bin/env node
/**
 * coordinator-read-guard.cjs - the coordinator answers a question with at most one confirming read
 * and hands a chain of reads to a worker (ntv-orca § 1, "Câu hỏi của user"). A rule alone did not
 * hold: answering "is X already there?" the coordinator ran its own grep/show/query chain across
 * child repos, the work a read-only worker does on a quota that costs less.
 * - UserPromptSubmit: starts a new turn (resets the count).
 * - PreToolUse(Bash|Read|Grep|Glob): a call that reads a watched place counts; the third one in a
 *   turn is denied unless the turn already ran `orca orchestration worker-start`.
 * Watched places come from the local list `~/.claude/knowledge/coordinator-reads.txt`, one per
 * line: a path prefix (`~/…` or absolute), or `cmd:<word>` for a command word (`cmd:ssh`). No list:
 * nothing is watched. Not counted: gh/glab, CI watching (watch.sh, ci.sh), git merge/push/pull/
 * fetch/worktree, any `orca` call (the gate and CI stay with the coordinator).
 * Passes: an Orca worker session, a subagent (`agent_id`), and a repo the session note names in a
 * `Người làm: Claude — <repo> — <evidence>` line (worker-default-guard's check: the user named
 * Claude for that repo, so reading it is Claude's work).
 * Fails open on any error.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { commands } = require('./lib/shell-words.cjs');
const { expandHome } = require('./lib/platform.cjs');
const { inside, repoOf, claimed, isWorker, liveLines } = require('./worker-default-guard.cjs');

const LIMIT = 2; // reads allowed per turn before a worker is required
const LIST = path.join(os.homedir(), '.claude', 'knowledge', 'coordinator-reads.txt');
const STATE_DIR = path.join(os.tmpdir(), 'claude-coordinator-reads');
const FREE_WORDS = new Set(['gh', 'glab', 'orca']);
const FREE_GIT = new Set(['merge', 'push', 'pull', 'fetch', 'worktree']);
const FREE_SCRIPT = /(^|\/)(watch|ci)\.sh$/;

// { paths, words } from the list file; null when there is none.
function watched(file = LIST) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const paths = [];
  const words = new Set();
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) continue;
    if (line.startsWith('cmd:')) words.add(line.slice(4).trim());
    else paths.push(path.resolve(expandHome(line)));
  }
  return { paths, words };
}

const word0 = (w) => path.basename(w || '');

// The watched path or command word a tool call reads, or null. `cwd` resolves relative paths and,
// for Bash, counts itself: a command run from inside a watched folder reads it.
function readTarget(data, list) {
  const input = data.tool_input || {};
  const cwd = data.cwd || process.cwd();
  const hit = (p) => {
    if (!p || p.startsWith('$')) return null;
    const abs = path.resolve(cwd, expandHome(p));
    return list.paths.find((w) => inside(abs, w)) ? abs : null;
  };
  if (data.tool_name !== 'Bash') return hit(input.file_path || input.path);
  const cmds = commands(input.command);
  for (const words of cmds) {
    const w = word0(words[0]);
    if (FREE_WORDS.has(w) || FREE_SCRIPT.test(words[0] || '') || words.some((x) => FREE_SCRIPT.test(x))) return null;
    if (w === 'git') {
      const sub = words.slice(1).find((x, i, a) => !x.startsWith('-') && a[i - 1] !== '-C');
      if (FREE_GIT.has(sub)) return null;
    }
  }
  for (const words of cmds) {
    if (list.words.has(word0(words[0]))) return word0(words[0]);
    for (const x of words.slice(1)) {
      const m = hit(x.replace(/^[^=]*=(?=[~/])/, ''));
      if (m) return m;
    }
  }
  return cmds.length ? hit(cwd) : null;
}

function statePath(sessionId) {
  return path.join(STATE_DIR, `${String(sessionId).replace(/[^\w.-]/g, '_')}.json`);
}
function load(sessionId) {
  try { return JSON.parse(fs.readFileSync(statePath(sessionId), 'utf8')); } catch { return { reads: 0, delegated: false }; }
}
function save(sessionId, state) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(statePath(sessionId), JSON.stringify(state));
}

const WORKER_START = /\borchestration\s+worker-start\b/;

// Why this call is blocked, or ''. Updates the turn's state as a side effect.
function decide(data, { list = watched(), notesDir } = {}) {
  if (!data.session_id) return '';
  if (data.hook_event_name === 'UserPromptSubmit') {
    save(data.session_id, { reads: 0, delegated: false });
    return '';
  }
  if (!list || data.agent_id) return '';
  const state = load(data.session_id);
  if (data.tool_name === 'Bash' && WORKER_START.test(String(data.tool_input?.command || ''))) {
    save(data.session_id, { ...state, delegated: true });
    return '';
  }
  if (state.delegated) return '';
  const target = readTarget(data, list);
  if (!target) return '';
  if (path.isAbsolute(target)) {
    const repo = repoOf(path.join(target, '_'));
    if (repo && claimed(liveLines(data.session_id, notesDir), repo, data.transcript_path)) return '';
  }
  if (isWorker(data.transcript_path)) return '';
  if (state.reads >= LIMIT) {
    return (
      `this would be read ${state.reads + 1} of a watched place (${target}) in this turn with no worker. ` +
      'The coordinator answers from what it has or one confirming read; a chain of reads goes to a ' +
      'read-only Orca worker (ntv-orca § 1, "Câu hỏi của user"): dispatch one and tell the user it is ' +
      'checking. If the user named Claude for this repo, add the `Người làm: Claude — <repo> — "<their sentence>"` ' +
      'line to the session note first.'
    );
  }
  save(data.session_id, { ...state, reads: state.reads + 1 });
  return '';
}

module.exports = { decide, readTarget, watched, LIMIT };
if (require.main !== module) return;

let raw = '';
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', () => {
  try {
    const why = decide(JSON.parse(raw));
    if (why) {
      process.stderr.write(`coordinator-read-guard: ${why}\n`);
      process.exit(2);
    }
  } catch (_) { /* fail-open */ }
  process.exit(0);
});
