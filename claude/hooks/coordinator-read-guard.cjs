#!/usr/bin/env node
/**
 * coordinator-read-guard.cjs - the coordinator answers a question with at most one confirming read
 * and hands a chain of reads to a worker (ntv-orca § 1, "Câu hỏi của user"). A rule alone did not
 * hold: answering "is X already there?" the coordinator ran its own grep/show/query chain across
 * child repos, the work a read-only worker does on a quota that costs less.
 * - UserPromptSubmit: starts a new turn (resets the count). A turn Orca's wake prompt opens handles a
 *   worker's report, so its reads (the gate: diff, checks) are not counted.
 * - PreToolUse(Bash|Read|Grep|Glob): a call that reads a watched place counts; the third one in a
 *   turn is denied unless the turn already ran `orca orchestration worker-start`. Two reads pass: the
 *   one confirming read the skill allows, plus one of slack, since a hook cannot tell a confirm
 *   from the start of a chain.
 * Watched places come from the local list `~/.claude/knowledge/coordinator-reads.txt`, one per
 * line: a path prefix (`~/…` or absolute), or `cmd:<word>` for a command word (`cmd:ssh`). No list:
 * nothing is watched. A Bash call reads a watched place when one of its simple commands names it:
 * an absolute or `~` path inside it, or a relative path that exists from cwd (so `git commit -m x`
 * run inside a watched repo does not count; `git log` with no path is not seen). Read/Grep/Glob:
 * their path, else cwd. Not counted: gh/glab, CI watching (watch.sh, ci.sh), git merge/push/pull/
 * fetch/worktree/add/commit/rm/mv/checkout/switch/stash, any `orca` call (the gate and CI stay with the coordinator), each judged per
 * simple command. Known limit: a turn woken without a prompt keeps the last turn's count.
 * Not counted either: a whole-file Read (no limit/offset) of the one file a project rules hook
 * makes Claude read before touching a checkout (`readsInstructions`): counting it left the two
 * hooks with no allowed path.
 * Passes: an Orca worker session, a subagent (`agent_id`), and a repo the session note names in a
 * `Người làm: Claude — <repo> — <evidence>` line (worker-default-guard's check: the user named
 * Claude for that repo, so reading it is Claude's work).
 * Fails open on any error.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { commands, program } = require('./lib/shell-words.cjs');
const { expandHome } = require('./lib/platform.cjs');
const { inside, repoOf, claimed, isWorker, liveLines } = require('./worker-default-guard.cjs');

const LIMIT = 2; // reads allowed per turn before a worker is required
const LIST = path.join(os.homedir(), '.claude', 'knowledge', 'coordinator-reads.txt');
const STATE_DIR = path.join(os.tmpdir(), 'claude-coordinator-reads');
const FREE_WORDS = new Set(['gh', 'glab', 'orca']);
const FREE_GIT = new Set(['merge', 'push', 'pull', 'fetch', 'worktree', 'add', 'commit', 'rm', 'mv', 'checkout', 'switch', 'stash']);
// Orca's wake prompt: the turn handles a worker's report (the gate), not a question.
const ORCA_WAKE = /orchestration message/i;
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

// The watched path or command word a tool call reads, or null.
function readTarget(data, list) {
  const input = data.tool_input || {};
  const cwd = data.cwd || process.cwd();
  const inList = (abs) => list.paths.some((w) => inside(abs, w));
  const named = (p, mustExist) => {
    if (!p || p.startsWith('$') || p.startsWith('-')) return null;
    const abs = path.resolve(cwd, expandHome(p));
    if (!inList(abs)) return null;
    return !mustExist || fs.existsSync(abs) ? abs : null;
  };
  if (data.tool_name !== 'Bash') return named(input.file_path || input.path || cwd, false);
  for (const raw of commands(input.command)) {
    const words = program(raw);
    const w = words[0] || '';
    const script = /^(ba|z|da)?sh$/.test(w) ? (words[1] || '') : w;
    if (FREE_WORDS.has(w) || FREE_SCRIPT.test(script)) continue;
    if (w === 'git') {
      let i = 1;
      while (i < words.length && words[i].startsWith('-')) i += /^-[Cc]$/.test(words[i]) ? 2 : 1;
      if (FREE_GIT.has(words[i])) continue;
    }
    if (list.words.has(w)) return w;
    for (const x of words.slice(1)) {
      const v = x.replace(/^[^=]*=(?=[~/.])/, '');
      const m = named(v, !(v.startsWith('~') || path.isAbsolute(v)));
      if (m) return m;
    }
  }
  return null;
}

// True when the call is a whole-file Read of the one instructions file a checkout's rules hook asks
// for: in a directory holding `.git` and `AGENTS.md` or `CLAUDE.md`, the first of `AGENTS.md`,
// `README.md`, `CLAUDE.md` there, resolving to a file in that same directory.
function readsInstructions(data) {
  const input = data.tool_input || {};
  if (data.tool_name !== 'Read' || input.limit != null || input.offset != null || !input.file_path) return false;
  try {
    const file = path.resolve(data.cwd || process.cwd(), expandHome(input.file_path));
    const dir = path.dirname(file);
    const has = (name) => fs.existsSync(path.join(dir, name));
    if (!has('.git') || !(has('AGENTS.md') || has('CLAUDE.md'))) return false;
    if (path.basename(file) !== ['AGENTS.md', 'README.md', 'CLAUDE.md'].find(has)) return false;
    return path.dirname(fs.realpathSync(file)) === fs.realpathSync(dir);
  } catch {
    return false;
  }
}

// True when the call starts an Orca worker (not its --help).
function startsWorker(data) {
  if (data.tool_name !== 'Bash') return false;
  return commands(data.tool_input?.command).some((raw) => {
    const words = program(raw);
    const at = words.indexOf('worker-start');
    return words[0] === 'orca' && at > 0 && words.slice(0, at).includes('orchestration') &&
      !words.includes('--help') && !words.includes('-h');
  });
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

// Why this call is blocked, or ''. Updates the turn's state as a side effect.
function decide(data, { list = watched(), notesDir } = {}) {
  if (!data.session_id) return '';
  if (data.hook_event_name === 'UserPromptSubmit') {
    save(data.session_id, { reads: 0, delegated: ORCA_WAKE.test(String(data.prompt || '')) });
    return '';
  }
  if (!list || data.agent_id) return '';
  const state = load(data.session_id);
  if (startsWorker(data)) {
    save(data.session_id, { ...state, delegated: true });
    return '';
  }
  if (state.delegated || readsInstructions(data)) return '';
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
      'read-only Orca worker (ntv-orca § 1, "Câu hỏi của user"): dispatch one now (no manifest: the ' +
      'question opens a block for it) and tell the user it is checking. If the user named Claude for this repo, add the `Người làm: Claude — <repo> — "<their sentence>"` ' +
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
