#!/usr/bin/env node
/**
 * note-recall.cjs - PreToolUse(Bash): what this session wrote in its note about a command is read
 * again before that command runs (rules/mine/session-notes.md: the note is kept to be read).
 * The note lines that name the command (two or more of its distinctive words, one of them an
 * argument value such as a model slug or branch, not only program/subcommand names; message and
 * body text never count) block the call once, quoted in the message;
 * the same call run again after reading passes, and a line already shown stays quiet for
 * QUIET_MS. Blocking, not `additionalContext`: PreToolUse context reaches the model next to the
 * tool result, after the command ran. Fails open.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { commands, program } = require('./lib/shell-words.cjs');
const { toSlash } = require('./lib/platform.cjs');

const NOTES_DIR = path.join(os.homedir(), '.claude', 'session-notes');
const STATE_DIR = path.join(os.tmpdir(), 'claude-note-recall');
const QUIET_MS = 30 * 60 * 1000;
const NO_NOTE_RECHECK_MS = 60 * 1000;
const MAX_LINES = 5;
const STOP = new Set(('git gh glab cd ls cat echo printf grep rg sed awk head tail wc find xargs sort uniq ' +
  'mkdir cp mv rm touch chmod test true false python python3 node npm npx pnpm bash sh zsh source ' +
  'tee diff jq curl open sleep date env export set origin main head json the and for with not ' +
  'list status read show view get run log').split(' '));
// Free text, not a route: an argument holding spaces (a message, a body, a prompt) never picks
// note lines, except the value of --command, which is a command line.
const PROSE_PROGRAM = /^(echo|printf|cat)$/;

const clean = (w) => w.replace(/^[('"]+|[)'",.:;]+$/g, '').toLowerCase();
const keep = (t) => t.length >= 3 && !t.startsWith('-') && !/^[~/.$]/.test(t) && !/^[\d.:]+$/.test(t) &&
  !/[=:]/.test(t) && !STOP.has(t);

// Distinctive words of a command, split in two: `names` (the program and up to two plain
// subcommand words right after it) and `values` (the rest: a model slug, a branch, the words of
// a --command). Arguments with spaces (other than --command) and echo/printf/cat ones are dropped.
function tokens(command) {
  const names = new Set();
  const values = new Set();
  for (const [name, ...args] of commands(command).map(program)) {
    if (!name) continue;
    const n = clean(toSlash(name).replace(/^.*\//, ''));
    if (keep(n)) names.add(n);
    if (PROSE_PROGRAM.test(name)) continue;
    let subs = 0;
    for (let k = 0; k < args.length; k++) {
      const a = args[k];
      if (a.startsWith('-')) { subs = 2; continue; }
      const isCommand = args[k - 1] === '--command' || /^--command=/.test(args[k - 1] || '');
      if (/\s/.test(a) && !isCommand) continue;
      if (subs < 2 && /^[a-z][a-z-]*$/.test(a)) { subs++; if (keep(a)) names.add(a); continue; }
      subs = 2;
      for (const w of a.split(/\s+/)) {
        const t = clean(w);
        if (keep(t)) values.add(t);
      }
    }
  }
  for (const t of names) values.delete(t);
  return { names: [...names], values: [...values] };
}

const hasWord = (line, t) => new RegExp(`(^|[^\\p{L}\\p{N}_-])${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}\\p{N}_-])`, 'iu').test(line);

const sessionLine = (text) => {
  const head = text.match(/^---\n([\s\S]*?)\n---/);
  return head ? { head: head[0], session: (head[1].match(/^session:.*$/m) || [''])[0] } : null;
};
const noteFiles = (dir) => { try { return fs.readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => path.join(dir, f)); } catch { return []; } };

// This session's notes. The launch-dir folder (the transcript's project slug) is read first, then
// the paths found by an earlier scan; the whole tree only when both miss, a miss cached for
// NO_NOTE_RECHECK_MS.
function ownNotes(sessionId, slug, now = Date.now()) {
  const read = (files) => files.flatMap((file) => {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
    const h = sessionLine(text);
    return h && h.session.replace(/^session:/, '').split(/[,\s]+/).includes(sessionId) ? [{ file, body: text.slice(h.head.length) }] : [];
  });
  if (slug) {
    const near = read(noteFiles(path.join(NOTES_DIR, slug)));
    if (near.length) return near;
  }
  const found = path.join(STATE_DIR, `${safe(sessionId)}.paths`);
  try {
    const cached = read(JSON.parse(fs.readFileSync(found, 'utf8')));
    if (cached.length) return cached;
  } catch { /* no cache */ }
  const miss = path.join(STATE_DIR, `${safe(sessionId)}.nonote`);
  try { if (now - fs.statSync(miss).mtimeMs < NO_NOTE_RECHECK_MS) return []; } catch { /* no cache */ }
  let dirs = [];
  try { dirs = fs.readdirSync(NOTES_DIR); } catch { return []; }
  const all = read(dirs.flatMap((d) => noteFiles(path.join(NOTES_DIR, d))));
  fs.mkdirSync(STATE_DIR, { recursive: true });
  if (all.length) fs.writeFileSync(found, JSON.stringify([...new Set(all.map((n) => n.file))]));
  else fs.writeFileSync(miss, '');
  return all;
}

// Note lines naming this command, as [{ file, line }]: two or more of its words, one of them a
// value; a long value with `/` or `-` (a branch, a model slug) is distinctive enough alone.
function recall(notes, command) {
  const { names, values } = tokens(command);
  if (!values.length) return [];
  const hits = [];
  for (const { file, body } of notes) {
    for (const line of body.split('\n')) {
      if (!line.trim() || /^#/.test(line)) continue;
      const vs = values.filter((t) => hasWord(line, t));
      const strong = vs.some((t) => t.length >= 8 && /[/-]/.test(t));
      if (vs.length && (strong || vs.length + names.filter((t) => hasWord(line, t)).length >= 2)) {
        hits.push({ file, line: line.trim() });
      }
    }
  }
  return hits;
}

const safe = (sid) => String(sid).replace(/[^\w-]/g, '_');
const hash = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);
const stateFile = (sid) => path.join(STATE_DIR, `${safe(sid)}.jsonl`);
// Shown lines as { hash: time }; one JSONL line per showing, so parallel calls never overwrite each other.
function shown(sid) {
  const out = {};
  let lines = [];
  try { lines = fs.readFileSync(stateFile(sid), 'utf8').split('\n'); } catch { return out; }
  for (const l of lines) { try { const [t, hs] = JSON.parse(l); for (const h of hs) out[h] = t; } catch { /* partial line */ } }
  return out;
}

function check(sessionId, command, slug, now = Date.now()) {
  const hits = recall(ownNotes(sessionId, slug, now), command);
  if (!hits.length) return null;
  const seen = shown(sessionId);
  const fresh = hits.filter((h) => !(now - (seen[hash(h.line)] || 0) < QUIET_MS));
  if (!fresh.length) return null;
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.appendFileSync(stateFile(sessionId), JSON.stringify([now, fresh.map((h) => hash(h.line))]) + '\n');
  return fresh;
}

if (require.main === module) {
  let raw = '';
  process.stdin.on('data', (c) => (raw += c));
  process.stdin.on('end', () => {
    try {
      const data = JSON.parse(raw);
      if (data.tool_name !== 'Bash' || !data.session_id || data.agent_id) process.exit(0);
      const slug = data.transcript_path ? path.basename(path.dirname(data.transcript_path)) : null;
      const fresh = check(data.session_id, (data.tool_input || {}).command || '', slug);
      if (fresh) {
        const files = [...new Set(fresh.map((h) => h.file))].join(', ');
        process.stderr.write(
          `note-recall: the session note (${files}) already says this about the command you are running:\n` +
            fresh.slice(0, MAX_LINES).map((h) => `  - ${h.line.slice(0, 400)}`).join('\n') +
            (fresh.length > MAX_LINES ? `\n  (+${fresh.length - MAX_LINES} more lines in the note)` : '') +
            '\nRead it: if the note gives a route or a decision for this, follow it (change the command). ' +
            'If the command already matches it, run it again unchanged; these lines will not block again.\n'
        );
        process.exit(2);
      }
    } catch (_) { /* fail-open */ }
    process.exit(0);
  });
}

module.exports = { tokens, recall, check };
