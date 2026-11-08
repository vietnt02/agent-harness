#!/usr/bin/env node
/**
 * coordinator-read-guard.cjs - the coordinator answers a question with at most one confirming read
 * and hands a chain of reads to a worker (ntv-orca § 1, "Câu hỏi của user"). A rule alone did not
 * hold: answering "is X already there?" the coordinator ran its own grep/show/query chain across
 * child repos, the work a read-only worker does on a quota that costs less.
 * - UserPromptSubmit: starts a new turn (resets the count). A turn Orca's wake prompt opens handles a
 *   worker's report, so its reads (the gate: diff, checks) are not counted.
 * - PreToolUse(Bash|Read|Grep|Glob): a call that reads a watched place once the turn holds two,
 *   unless the turn already ran `orca orchestration worker-start`, gets a nudge back as context, once per
 *   turn: the read still runs (a read costs quota, not output), the model is reminded a chain of reads
 *   belongs to a worker. Two reads pass quietly: the
 *   one confirming read the skill allows, plus one of slack, since a hook cannot tell a confirm
 *   from the start of a chain. A call that passes leaves a pending mark (one file per call).
 * - PostToolUse / PostToolUseFailure (same tools): the call ran, so its pending mark becomes a
 *   counted one; the target is the one PreToolUse saw (a command that creates a path is no read).
 *   A worker-start unlocks the turn only at PostToolUse (it succeeded).
 * The turn holds its counted marks plus pending marks younger than PENDING_MS. Calls sent in
 * parallel all pass PreToolUse before any PostToolUse, so a fresh pending mark counts; a call
 * another PreToolUse hook denied never gets a PostToolUse, and the next call the model writes
 * comes seconds later, past PENDING_MS, so it is not counted (hooks run in parallel and never see
 * each other's decision); a retry within PENDING_MS is counted (known limit). Count and mark run
 * under a per-turn lock; one file per mark, so parallel PostToolUse calls lose no update.
 * Watched places come from the local list `~/.claude/knowledge/coordinator-reads.txt`, one per
 * line: a path prefix (`~/…` or absolute), or `cmd:<word>` for a command word (`cmd:ssh`). No list:
 * nothing is watched. A Bash call reads a watched place when one of its simple commands names it:
 * an absolute or `~` path inside it, or a relative path that exists from cwd (so `git commit -m x`
 * run inside a watched repo does not count; `git log` with no path is not seen). A git `<rev>:<path>`
 * argument names `<path>` from the repo of `-C <dir>` (else cwd), so `git show :2:f` reads `f` as a
 * Read of it would. Read/Grep/Glob:
 * their path, else cwd. Not counted: gh/glab, CI watching (watch.sh, ci.sh), git merge/push/pull/
 * fetch/worktree/add/commit/rm/mv/checkout/switch/stash, any `orca` call (the gate and CI stay with the coordinator), each judged per
 * simple command. Known limit: a turn woken without a prompt keeps the last turn's count.
 * Not counted either: a whole-file Read (no limit/offset) of the one file a project rules hook
 * makes Claude read before touching a checkout (`readsInstructions`): counting it left the two
 * hooks with no allowed path.
 * Passes: an Orca worker session, a subagent (`agent_id`), and a read the session note covers with a
 * `Người làm: Claude — <place> — <evidence>` line (claimedTarget, worker-default-guard's check: the
 * user named Claude for it, so reading it is Claude's work); <place> is a repo or folder on the read
 * path, a watched command word or its operand (`ssh`, a host), or `*` for the whole session.
 * Fails open on any error.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
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
// git subcommands whose `<rev>:<path>` arguments read a file's content.
const REV_READS = new Set(['show', 'cat-file', 'diff', 'grep', 'archive']);
const PENDING_MS = 5000;

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

// The top folder of the repo holding `dir`, or null. Built from `dir` (`--show-cdup`) so a symlinked
// path keeps the form the watched list uses.
function gitRoot(dir) {
  try {
    const up = execFileSync('git', ['-C', dir, 'rev-parse', '--show-cdup'], {
      encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return path.resolve(dir, up);
  } catch { return null; }
}

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
    if (w === 'git') {
      let dir = cwd;
      let i = 1;
      while (i < words.length && words[i].startsWith('-')) {
        if (words[i] === '-C') dir = path.resolve(dir, expandHome(words[i + 1] || ''));
        i += /^-[Cc]$/.test(words[i]) ? 2 : 1;
      }
      if (REV_READS.has(words[i])) {
        let root;
        for (const x of words.slice(i + 1)) {
          if (/^[A-Za-z]:[\\/]/.test(x)) continue; // a Windows drive path, not <rev>:<path>
          if (/^[^:\s@]+@[^:\s{]+:/.test(x)) continue; // user@host:path, not a revision
          const rev = /^([^:\s-][^:\s]*)?:(?:[0-3]:)?(?!\/)(.+)$/.exec(x);
          if (!rev) continue;
          if (root === undefined) root = gitRoot(dir);
          if (!root) break;
          const p = rev[2];
          const m = named(rev[1] && /^\.\.?\//.test(p) ? path.join(dir, p) : path.join(root, p), false);
          if (m) return m;
        }
      }
    }
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
// `README.md`, `CLAUDE.md` there. A symlink counts as that file wherever it leads: the rules hook
// demands that path, so counting it would bring back the deadlock; one file per checkout is exempt.
function readsInstructions(data) {
  const input = data.tool_input || {};
  if (data.tool_name !== 'Read' || input.limit != null || input.offset != null || !input.file_path) return false;
  const file = path.resolve(data.cwd || process.cwd(), expandHome(input.file_path));
  const dir = path.dirname(file);
  const has = (name) => fs.existsSync(path.join(dir, name));
  if (!has('.git') || !(has('AGENTS.md') || has('CLAUDE.md'))) return false;
  return path.basename(file) === ['AGENTS.md', 'README.md', 'CLAUDE.md'].find(has);
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

const safe = (s) => String(s).replace(/[^\w.-]/g, '_');
const turnDir = (sessionId) => path.join(STATE_DIR, safe(sessionId));
function turnState(sessionId) {
  try { return JSON.parse(fs.readFileSync(path.join(turnDir(sessionId), 'turn.json'), 'utf8')); } catch { return { delegated: false }; }
}
function newTurn(sessionId, state) {
  const dir = turnDir(sessionId);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'marks'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'turn.json'), JSON.stringify(state));
}
// The key of one call: its tool_use_id, else a hash of the call (tests, older payloads).
function callKey(data) {
  if (data.tool_use_id) return safe(data.tool_use_id);
  return require('crypto').createHash('sha1').update(`${data.tool_name}\0${JSON.stringify(data.tool_input || {})}`).digest('hex').slice(0, 16);
}
function marks(sessionId) {
  const dir = path.join(turnDir(sessionId), 'marks');
  try { return fs.readdirSync(dir).map((f) => ({ f, file: path.join(dir, f) })); } catch { return []; }
}
// Counted marks plus pending marks younger than pendingMs.
function held(sessionId, now, pendingMs) {
  return marks(sessionId).filter(({ f, file }) => {
    if (f.startsWith('c.')) return true;
    try { return now - fs.statSync(file).mtimeMs < pendingMs; } catch { return false; }
  }).length;
}
function markPending(sessionId, key, now) {
  const dir = path.join(turnDir(sessionId), 'marks');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `p.${key}.${now}.${process.pid}.${Math.random().toString(36).slice(2, 8)}`);
  fs.writeFileSync(file, '');
  const t = now / 1000;
  fs.utimesSync(file, t, t);
}
// Runs `fn` holding the turn's lock (an atomic mkdir); a lock older than 2 s is stale. Not got
// within 1 s: runs without it (fail-open).
function withLock(sessionId, fn) {
  fs.mkdirSync(turnDir(sessionId), { recursive: true });
  const lock = path.join(turnDir(sessionId), 'lock');
  const until = Date.now() + 1000;
  let got = false;
  while (!got && Date.now() < until) {
    try { fs.mkdirSync(lock); got = true; } catch {
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 2000) fs.rmdirSync(lock); } catch { /* gone */ }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3);
    }
  }
  try { return fn(); } finally { if (got) try { fs.rmdirSync(lock); } catch { /* gone */ } }
}

// Turns the oldest pending mark of this call into a counted one.
function markRan(sessionId, key) {
  const mine = marks(sessionId).filter(({ f }) => f.startsWith(`p.${key}.`)).sort((a, b) => a.f.localeCompare(b.f, 'en', { numeric: true }));
  for (const { f, file } of mine) {
    try { fs.renameSync(file, path.join(path.dirname(file), `c.${f.slice(2)}`)); return; } catch { /* taken by a parallel call */ }
  }
}

// ssh options that take a value: the host is the first operand after them.
const SSH_VALUE = /^-[BbcDEeFIiJLlmOoPpQRSWw]$/;

// True when a `Người làm: Claude — <place> — "<the user's sentence>"` line of the session note covers
// this read; only a quote of the user counts here, never a `→` value line. <place> is `*` (the whole
// session), the repo or a folder below the watched prefix on the read path, or, for a watched
// command word, the word itself or its first operand (`ssh -i k deploy@web1 …`: `ssh`, `web1`).
function claimedTarget(target, data, list, notesDir) {
  const names = new Set(['*']);
  if (path.isAbsolute(target)) {
    const repo = repoOf(path.join(target, '_'));
    if (repo) for (const n of repo.names) names.add(n);
    const root = list.paths.find((w) => inside(target, w));
    if (root) for (const seg of path.relative(root, target).split(/[\\/]/)) if (seg && seg !== '..') names.add(seg);
  } else {
    names.add(target);
    for (const raw of commands((data.tool_input || {}).command)) {
      const words = program(raw);
      if (words[0] !== target) continue;
      for (let i = 1; i < words.length; i++) {
        if (words[i].startsWith('-')) { if (target === 'ssh' && SSH_VALUE.test(words[i])) i++; continue; }
        names.add(words[i].replace(/^[^@\s]*@/, '').split(':')[0]);
        break;
      }
    }
  }
  return claimed(liveLines(data.session_id, notesDir), { names }, data.transcript_path, { quoteOnly: true });
}

// Why this call is blocked, or ''. Every event updates the turn's state.
function decide(data, { list = watched(), notesDir, now = Date.now(), pendingMs = PENDING_MS } = {}) {
  if (!data.session_id) return '';
  const sid = data.session_id;
  const event = String(data.hook_event_name || 'PreToolUse');
  if (event === 'UserPromptSubmit') {
    newTurn(sid, { delegated: ORCA_WAKE.test(String(data.prompt || '')) });
    return '';
  }
  if (!list || data.agent_id) return '';
  if (/^PostToolUse/.test(event)) {
    if (startsWorker(data)) {
      if (event === 'PostToolUse') {
        fs.mkdirSync(turnDir(sid), { recursive: true });
        fs.writeFileSync(path.join(turnDir(sid), 'turn.json'), JSON.stringify({ ...turnState(sid), delegated: true }));
      }
    } else markRan(sid, callKey(data));
    return '';
  }
  const state = turnState(sid);
  if (startsWorker(data)) return '';
  if (state.delegated || readsInstructions(data)) return '';
  const target = readTarget(data, list);
  if (!target) return '';
  if (claimedTarget(target, data, list, notesDir)) return '';
  if (isWorker(data.transcript_path)) return '';
  // Count and mark under one lock: parallel PreToolUse calls are separate processes.
  const count = withLock(sid, () => {
    const n = held(sid, now, pendingMs);
    if (n < LIMIT) markPending(sid, callKey(data), now);
    return n;
  });
  if (count < LIMIT) return '';
  {
    return (
      `this is read ${count + 1} of a watched place (${target}) in this turn with no worker; it runs. ` +
      'A chain of reads is cheaper on a read-only Orca worker (ntv-orca § 1, "Câu hỏi của user"): if more ' +
      'are coming, dispatch one (no manifest: the question opens a block for it) and tell the user it is ' +
      'checking. Said once this turn. If the user named Claude for this work, add ' +
      '`Người làm: Claude — <place> — "<their sentence>"` under `## Đang có hiệu lực` of the session note first: <place> is the repo, ' +
      'the command or host (`ssh`, a host name), several comma-separated, or `*` when they named Claude for the whole session.'
    );
  }
}

// True the first time this turn is nudged; remembers it in the turn's state.
function firstNudge(sessionId) {
  if (!sessionId) return true;
  const state = turnState(sessionId);
  if (state.nudged) return false;
  try {
    fs.mkdirSync(turnDir(sessionId), { recursive: true });
    fs.writeFileSync(path.join(turnDir(sessionId), 'turn.json'), JSON.stringify({ ...state, nudged: true }));
  } catch { /* nudged again next call: still only a note */ }
  return true;
}

module.exports = { decide, readTarget, watched, firstNudge, LIMIT };
if (require.main !== module) return;

let raw = '';
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(raw);
    const why = decide(data);
    if (why && firstNudge(data.session_id)) {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: `coordinator-read-guard: ${why}` },
      }));
    }
  } catch (_) { /* fail-open */ }
  process.exit(0);
});
