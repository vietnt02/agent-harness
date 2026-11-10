#!/usr/bin/env node
/**
 * note-recall.cjs - PreToolUse(Bash): what this session wrote in its note about a command is read
 * again before that command runs (rules/mine/session-notes.md: the note is kept to be read).
 * The lines under `## Đang có hiệu lực` that name the command (two or more of its distinctive words, one of them an
 * argument value such as a model slug or branch, not only program/subcommand names; message and
 * body text never count) block the call once, quoted in the message;
 * the same call run again after reading passes, and a line already shown stays quiet for
 * QUIET_MS. Blocking, not `additionalContext`: PreToolUse context reaches the model next to the
 * tool result, after the command ran. A command that only reads (readOnly) gets the lines as
 * context instead: reading before them harms nothing, and a block there costs a rerun. Fails open.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { commands, program, innerScript } = require('./lib/shell-words.cjs');
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
  for (const { file, body: raw } of notes) {
    // Only `## Đang có hiệu lực` holds what a command must honour (approvals, limits, decisions);
    // `## Resume` and `## Đã xong` are IDs and `## Đang làm` the next step, so a command naming them
    // is the plan itself, not a reason to stop. A note in an older layout (none of the four sections of
    // rules/mine/session-notes.md) is read whole. NFC and LF first, and a `## ` inside a code fence ends no section, as in session-notes.cjs.
    const body = String(raw).normalize('NFC').replace(/\r\n?/g, '\n');
    const lines = body.split('\n');
    const isLive = (l) => /^##\s+Đang có hiệu lực\b/u.test(l);
    let fence = false;
    const fourSections = lines.some((l) => {
      if (/^\s*```/.test(l)) fence = !fence;
      return !fence && /^##\s+(Đang làm|Đang có hiệu lực|Đã xong|Resume)\s*$/u.test(l);
    });
    let live = !fourSections;
    fence = false;
    for (const line of lines) {
      if (/^\s*```/.test(line)) { fence = !fence; continue; }
      if (!fence && fourSections && /^##\s/.test(line)) { live = isLive(line); continue; }
      if (!live || !line.trim() || /^#/.test(line)) continue;
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

// `read`: a line shown to a read is kept apart from one shown to a write, so a read first never
// spares the write that follows its block.
function check(sessionId, command, slug, now = Date.now(), read = false) {
  const hits = recall(ownNotes(sessionId, slug, now), command);
  if (!hits.length) return null;
  const seen = shown(sessionId);
  const key = (h) => hash(read ? `read:${h.line}` : h.line);
  const fresh = hits.filter((h) => !(now - (seen[key(h)] || 0) < QUIET_MS));
  if (!fresh.length) return null;
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.appendFileSync(stateFile(sessionId), JSON.stringify([now, fresh.map(key)]) + '\n');
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
      const command = (data.tool_input || {}).command || '';
      const read = readOnly(command);
      const fresh = check(data.session_id, command, slug, Date.now(), read);
      if (fresh) {
        const files = [...new Set(fresh.map((h) => h.file))].join(', ');
        const quoted =
          `note-recall: the session note (${files}) already says this about the command you are running:\n` +
            fresh.slice(0, MAX_LINES).map((h) => `  - ${h.line.slice(0, 400)}`).join('\n') +
            (fresh.length > MAX_LINES ? `\n  (+${fresh.length - MAX_LINES} more lines in the note)` : '');
        if (read) {
          process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse',
            additionalContext: `${quoted}\nThis command only reads; follow these lines in the next step that changes something.` } }));
          process.exit(0);
        }
        process.stderr.write(quoted +
            '\nRead it: if the note gives a route or a decision for this, follow it (change the command). ' +
            'If the command already matches it, run it again unchanged; these lines will not block again.\n'
        );
        process.exit(2);
      }
    } catch (_) { /* fail-open */ }
    process.exit(0);
  });
}

// True when every command in the line only reads: a known reader with no write flag and no output
// redirect to a file. `ssh host '<script>'` and `bash -c '<script>'` are read by their script.
// Anything not listed counts as a write, so an unknown command still blocks.
const READERS = new Set(('cat head tail grep rg egrep fgrep ls wc cut tr jq diff cmp stat file ' +
  'readlink realpath basename dirname pwd echo printf which type test true false dig nslookup host ' +
  'ping whoami id column less nl od hexdump strings md5 shasum sha256sum ps df du').split(' '));
const GIT_READS = new Set(['diff', 'log', 'show', 'status', 'fetch', 'rev-parse', 'grep', 'ls-files',
  'ls-remote', 'blame', 'cat-file', 'shortlog', 'describe', 'merge-base', 'rev-list', 'show-ref']);
const FORGE_READS = { pr: /^(view|list|diff|checks|status)$/, mr: /^(view|list|diff)$/, issue: /^(view|list)$/,
  run: /^(view|list)$/, ci: /^(view|list|status)$/, repo: /^view$/, release: /^(view|list)$/ };
const positional = (args) => args.filter((a) => !a.startsWith('-'));
// curl flags that send a body, pick a method or write a file, long or packed into short ones (`-fsSLO`).
const CURL_WRITE = /^--(request|data|json|form|upload-file|output|remote-name|config|post|dump-header|cookie-jar|trace|stderr|libcurl|etag-save)/;
const CURL_SHORT = /^-[a-zA-Z]*[XdFTOoKDc]/;
const SED_WRITE = /(^|[;{}\n])\s*[\d,$]*\s*[we]\b|\/[gpiImM\d]*[we](\s|;|$)|s(.)(?:(?!\3).)*\3(?:(?!\3).)*\3[gpiImM\d]*[we](\s|;|$)/;
function readOnly(command) {
  // `2>&1` and `>/dev/null` write no file; dropped first, since the parser splits `2>&1` at the `&`.
  const plain = String(command).replace(/\d?>&\d|(&|\d)?>>?\s*\/dev\/null(?![\w./-])/g, ' ');
  return commands(plain).map(program).every((words) => {
    const [cmd, ...args] = words;
    if (!cmd || cmd === 'cd') return true;
    if (words.some((w) => w.includes('>'))) return false; // a redirect, glued or not (a quoted `>` blocks too)
    const inner = innerScript(words);
    if (inner !== null) return readOnly(inner);
    if (cmd === 'ssh') {
      const script = args.filter((a, k) => !a.startsWith('-') && !/^-[bcDEeFIiJLlmOopQRSWw]$/.test(args[k - 1] || '')).slice(1);
      return script.length > 0 && readOnly(script.join(' '));
    }
    if (cmd === 'sed') return !args.some((a) => /^-[a-zA-Z]*i/.test(a) || a.startsWith('--in-place') || SED_WRITE.test(a));
    if (cmd === 'find') return !args.some((a) => /^-(delete|exec|execdir|ok|okdir|fprint|fls)/.test(a));
    if (cmd === 'awk') return !args.some((a) => /system|\||getline|^-i/.test(a));
    if (cmd === 'sort') return !args.some((a) => /^(-o|--output)/.test(a) || /^-[a-zA-Z]*o/.test(a));
    if (cmd === 'uniq') return positional(args).length <= 1;
    if (cmd === 'date' || cmd === 'hostname') return !args.some((a) => /^(-s|--set)/.test(a)) && (cmd === 'date' ? !positional(args).some((a) => /^\d/.test(a)) : !positional(args).length);
    if (cmd === 'rg' && args.some((a) => /^--pre(=|$)/.test(a))) return false;
    if (cmd === 'git') {
      if (args[0] === '-c' || args.some((a) => /^--output(=|$)/.test(a))) return false;
      let i = 0;
      while (args[i] && args[i].startsWith('-')) i += args[i] === '-C' ? 2 : 1;
      if (args[i] === 'fetch' && args.slice(i + 1).some((a) => a.includes(':'))) return false;
      return GIT_READS.has(args[i]);
    }
    if (cmd === 'curl') return !args.some((a) => CURL_WRITE.test(a) || (!a.startsWith('--') && CURL_SHORT.test(a)));
    if (cmd === 'gh' || cmd === 'glab') {
      if (args[0] === 'api') {
        const method = args.find((a, k) => ['-X', '--method'].includes(args[k - 1])) ||
          (args.find((a) => /^(--method=|-X)\w/.test(a)) || '').replace(/^(--method=|-X)/, '') || 'GET';
        return /^get$/i.test(method) && !args.some((a) => /^(-f|-F|--field|--raw-field|--input)/.test(a));
      }
      return Boolean(FORGE_READS[args[0]] && FORGE_READS[args[0]].test(args[1] || ''));
    }
    return READERS.has(cmd);
  });
}

module.exports = { tokens, recall, check, readOnly };
