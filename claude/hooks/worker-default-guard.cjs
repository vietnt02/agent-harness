#!/usr/bin/env node
/**
 * worker-default-guard.cjs - PreToolUse(Write|Edit|MultiEdit|NotebookEdit|Bash): execution goes to Orca
 * workers (CLAUDE.md § Delegation); Claude edits a repo itself only in the cases ntv-implement
 * § Who works lists, and says which first. An edit to a file inside a git repo outside ~/.claude
 * gets a reminder back as context (once per repo per session; the edit still runs: who edits costs
 * quota, not output) until this session's note (rules/agent-harness/session-notes.md) holds, under
 * `## Đang có hiệu lực`, a line `Người làm: Claude — <repo folder> — <evidence>` naming that repo
 * (its folder, or its main checkout's folder for a linked worktree), where the evidence is a
 * quoted sentence found in one of the user's messages, or a value change written with `→`.
 * Passes: an Orca worker session (its first prompt opens with Orca's dispatch brief), a file
 * outside any git repo (scratchpad, Desktop), a file of ~/.claude itself, a `.md` under the repo's
 * `plans/` or `knowledge/` (specs and docs a coordinator writes). A subagent is checked like its
 * parent. A path under ~/.claude that symlinks into a repo (the harness repo holding the rules,
 * skills and hooks) is judged by where it leads: a fix to the harness belongs to a session the user
 * opened for it, and a harness bug met mid-task goes into a kaizen file, not a PR.
 * PreToolUse(Bash): a git command writing a commit (commit, merge, rebase, cherry-pick, am,
 * revert, pull; in cwd, after `cd <dir>`, or under `-C <dir>`) in the repo ~/.claude/CLAUDE.md links into
 * (same git common dir) needs the same line, since a commit there needs no Edit.
 * Limit: a shell write (sed -i, heredoc) is not seen; `--git-dir`/`GIT_DIR` are not followed.
 * Fails open when git or stdin fails (no repo known: nothing to guard); reminds when the note
 * or transcript cannot be read (no evidence: the reminder says how to add it).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { expandHome, toSlash, samePath } = require('./lib/platform.cjs');
const { commands, program } = require('./lib/shell-words.cjs');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const NOTES_DIR = path.join(CLAUDE_DIR, 'session-notes');
// Orca's dispatch brief opens with this line (Orca.app: ORCA_DISPATCH_PROMPT_LEAD_LINE).
const DISPATCH_LEAD = 'Please carry out this task from my Orca coordinator';
const HEAD_BYTES = 1024 * 1024;
const LIVE_HEADING = /^##\s+Đang có hiệu lực\b/u;
const ROLE_RE = /^\s*(?:[-*+]\s+)?Người làm:\s*Claude\s+[—–-]\s+(.+)$/u;
const QUOTE_RE = /"([^"]{8,})"|“([^”]{8,})”/u;
const VALUE_RE = /\S\s*→\s*\S/u;

// `file` with symlinks resolved; it may not exist yet, so resolve its nearest existing parent.
function realPath(file) {
  let dir = path.dirname(file);
  while (!fs.existsSync(dir) && path.dirname(dir) !== dir) dir = path.dirname(dir);
  return path.join(fs.realpathSync(dir), path.relative(dir, file));
}

function inside(file, dir) {
  if (process.platform === 'win32') {
    const f = path.resolve(file).toLowerCase();
    const d = path.resolve(dir).toLowerCase();
    return f === d || f.startsWith(d + path.sep) || f.startsWith(d + '/');
  }
  return file === dir || file.startsWith(dir + path.sep);
}
const clean = (s) => s.normalize('NFC').replace(/\r\n?/g, '\n');

const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

// { root, names } for the repo holding `file`: names are its folder and, for a linked worktree,
// the main checkout's folder. null when none. The file may not exist yet, or be a directory's
// path + `/_`: start at the nearest existing directory above it.
function repoOf(file) {
  let dir = path.dirname(file);
  while (!isDir(dir) && path.dirname(dir) !== dir) dir = path.dirname(dir);
  let out;
  try {
    out = execFileSync('git', ['-C', dir, 'rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir'], {
      encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim().split('\n');
  } catch {
    return null;
  }
  const [root, common] = out;
  if (!root) return null;
  const names = new Set([path.basename(root)]);
  if (common && path.basename(common) === '.git') names.add(path.basename(path.dirname(common)));
  let commonReal = common;
  try { commonReal = fs.realpathSync(common); } catch { /* keep as printed */ }
  return { root, names, common: commonReal };
}

// The texts of the transcript's user prompts (not tool results, meta lines or notifications), in order.
function userTexts(transcript, maxBytes = Infinity) {
  let raw = '';
  try {
    if (maxBytes === Infinity) raw = fs.readFileSync(transcript, 'utf8');
    else {
      const fd = fs.openSync(transcript, 'r');
      const buf = Buffer.alloc(maxBytes);
      raw = buf.toString('utf8', 0, fs.readSync(fd, buf, 0, maxBytes, 0));
      fs.closeSync(fd);
    }
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split('\n')) {
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    if (d.type !== 'user' || d.isMeta || !d.message) continue;
    // A task notification or a message from another session is typed into the transcript as a user
    // entry, with `origin.kind` other than `human`: its text is Claude's or an agent's, never Viet's.
    if (d.origin && typeof d.origin === 'object' && d.origin.kind && d.origin.kind !== 'human') continue;
    if (d.isCompactSummary) continue; // Claude wrote it

    const c = d.message.content;
    const text = typeof c === 'string' ? c
      : Array.isArray(c) ? c.filter((x) => x && x.type === 'text').map((x) => x.text || '').join('\n') : '';
    const t = text.trim();
    if (!t || /^<(command-|local-command|system-reminder)/.test(t)) continue;
    out.push(clean(t));
  }
  return out;
}

// True when the session's first user prompt opens with Orca's dispatch brief.
function isWorker(transcript) {
  if (!transcript) return false;
  const [first] = userTexts(transcript, HEAD_BYTES);
  return Boolean(first) && first.startsWith(DISPATCH_LEAD);
}

// The lines of the `## Đang có hiệu lực` section of every note whose `session:` line holds this id.
function liveLines(sessionId, notesDir = NOTES_DIR) {
  const out = [];
  let dirs = [];
  try { dirs = fs.readdirSync(notesDir); } catch { return out; }
  for (const d of dirs) {
    let files = [];
    try { files = fs.readdirSync(path.join(notesDir, d)).filter((f) => f.endsWith('.md')); } catch { continue; }
    for (const f of files) {
      let text = '';
      try { text = clean(fs.readFileSync(path.join(notesDir, d, f), 'utf8')); } catch { continue; }
      const head = (text.match(/^---\n[\s\S]*?\n---/) || [''])[0];
      const ids = ((head.match(/^session:(.*)$/m) || [])[1] || '').split(/[\s,[\]"']+/);
      if (!ids.includes(sessionId)) continue;
      let live = false;
      let fence = false;
      for (const line of text.slice(head.length).split('\n')) {
        if (/^\s*(```|~~~)/.test(line)) fence = !fence;
        if (!fence && /^## /.test(line)) { live = LIVE_HEADING.test(line); continue; }
        if (live) out.push(line.replace(/\*\*/g, ''));
      }
    }
  }
  return out;
}

// True when one role line names this repo with evidence that holds.
function claimed(lines, repo, transcript, { quoteOnly = false } = {}) {
  let texts = null;
  for (const line of lines) {
    const m = line.match(ROLE_RE);
    if (!m) continue;
    const [name, ...rest] = m[1].split(/\s+[—–-]\s+/);
    // One line may name several places, comma-separated (`repo_a, ssh`).
    const names = name.split(',').map((n) => toSlash(n.trim().replace(/^`|`$/g, '')).replace(/\/$/, '').split('/').pop());
    if (!names.some((n) => repo.names.has(n))) continue;
    const evidence = rest.join(' — ');
    const q = evidence.match(QUOTE_RE);
    if (q) {
      if (texts === null) texts = transcript ? userTexts(transcript) : [];
      const quote = (q[1] || q[2]).trim();
      if (texts.some((t) => t.includes(quote))) return true;
      continue;
    }
    if (!quoteOnly && VALUE_RE.test(evidence)) return true;
  }
  return false;
}

// The repo ~/.claude/CLAUDE.md links into (the harness), or null when it is a plain file.
function harnessRepo(claudeDir = CLAUDE_DIR) {
  let real;
  try { real = fs.realpathSync(path.join(claudeDir, 'CLAUDE.md')); } catch { return null; }
  return inside(real, fs.realpathSync(claudeDir)) ? null : repoOf(real);
}

// git subcommands that write a commit.
const COMMITS = new Set(['commit', 'merge', 'rebase', 'cherry-pick', 'am', 'revert', 'pull']);

// The folder each commit-writing git command runs in: cwd, a `cd <dir>` before it in the same
// command, then each `-C <dir>`.
function commitDirs(command, cwd) {
  const out = [];
  const cds = [];
  for (const raw of commands(command)) {
    const words = program(raw);
    const scope = raw.scope || '';
    // A `cd` holds for its own scope and the scopes inside it, not after a subshell closes.
    let base = cwd;
    for (const c of cds) if (scope === c.scope || scope.startsWith(`${c.scope}.`)) base = c.dir;
    if (words[0] === 'cd') {
      const to = words.slice(1).find((w) => !w.startsWith('-'));
      if (to && !to.startsWith('$')) cds.push({ scope, dir: path.resolve(base, expandHome(to)) });
      continue;
    }
    if (words[0] !== 'git') continue;
    let dir = base;
    let i = 1;
    while (i < words.length && words[i].startsWith('-')) {
      if (words[i] === '-C') dir = path.resolve(dir, expandHome(words[i + 1] || ''));
      i += /^-[Cc]$/.test(words[i]) ? 2 : 1;
    }
    if (COMMITS.has(words[i]) && !words.includes('--help')) out.push(dir);
  }
  return out;
}

// The reminder for this `git commit`, or ''.
function commitProblem(data, notesDir, claudeDir) {
  const dirs = commitDirs(String(data.tool_input?.command || ''), data.cwd || process.cwd());
  const harness = dirs.length ? harnessRepo(claudeDir) : null;
  if (!harness) return '';
  for (const dir of dirs) {
    const repo = repoOf(path.join(dir, '_'));
    if (!repo || repo.common !== harness.common) continue;
    if (claimed(liveLines(data.session_id, notesDir), repo, data.transcript_path)) return '';
    if (isWorker(data.transcript_path)) return '';
    return blockMessage(`committing in ${repo.root}`, repo);
  }
  return '';
}

// The repo root of the last reminder built: the key it is said once per.
let lastRoot = '';

function blockMessage(what, repo) {
  const name = [...repo.names].pop();
  lastRoot = repo.root;
  return (
    `${what}: the change goes ahead; a reminder, said once per repo this session. Execution usually goes to ` +
    'Orca workers (CLAUDE.md § Delegation; ntv-orca): Claude edits a repo itself for a change to an existing value ' +
    'with no new logic, or work the user named Claude for (ntv-implement § Who works); a harness bug met during ' +
    'other work goes into a kaizen file (ntv-kaizen). If one holds, note it under `## Đang có hiệu lực` of ' +
    `this session's note: \`- Người làm: Claude — ${name} — "<the user's exact sentence naming Claude>"\` or ` +
    `\`- Người làm: Claude — ${name} — <file>: <key> <old>→<new>\`. Otherwise hand the rest to a worker.`
  );
}


// True the first time this session is reminded about this repo; remembers it.
function firstNudge(sessionId, repoRoot) {
  const file = path.join(os.tmpdir(), 'claude-worker-default', `${String(sessionId || 'none').replace(/[^\w-]/g, '_')}.json`);
  let told = [];
  try { told = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first time */ }
  const key = String(repoRoot || '');
  if (told.includes(key)) return false;
  told.push(key);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(told));
  } catch { /* reminded again next time: still only a note */ }
  return true;
}

// The reminder for this edit, or '' when none is due.
function problem(data, notesDir = NOTES_DIR, claudeDir = CLAUDE_DIR) {
  if (!data.session_id) return '';
  if (data.tool_name === 'Bash') return commitProblem(data, notesDir, claudeDir);
  const input = data.tool_input || {};
  const target = input.file_path || input.notebook_path;
  if (!target) return '';
  let file = path.resolve(data.cwd || process.cwd(), expandHome(target));
  if (inside(file, claudeDir)) {
    const real = fs.existsSync(file) ? fs.realpathSync(file) : realPath(file);
    if (inside(real, fs.realpathSync(claudeDir))) return '';
    file = real;
  }
  const repo = repoOf(file);
  if (!repo) return '';
  const rel = toSlash(path.relative(fs.realpathSync(repo.root), realPath(file)));
  if (/^(plans|knowledge)\//.test(rel) && rel.endsWith('.md')) return '';
  if (claimed(liveLines(data.session_id, notesDir), repo, data.transcript_path)) return '';
  if (isWorker(data.transcript_path)) return '';
  return blockMessage(`editing ${file} in ${repo.root}`, repo);
}

module.exports = { problem, firstNudge, commitDirs, harnessRepo, inside, realPath, repoOf, claimed, isWorker, liveLines, userTexts };
if (require.main !== module) return;

let raw = '';
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(raw);
    const why = problem(data);
    if (why && firstNudge(data.session_id, lastRoot || why)) {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: `worker-default-guard: ${why}` },
      }));
    }
  } catch (_) { /* fail-open */ }
  process.exit(0);
});
