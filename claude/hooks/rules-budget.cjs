#!/usr/bin/env node
/**
 * rules-budget.cjs - PreToolUse(Edit|Write|MultiEdit): block an edit that grows a personal rule
 * file past its character budget, or CLAUDE.md plus rules/mine/*.md past their joint budget.
 * Characters, not lines: a line cap only made sentences denser. The rule gets a tightened
 * sentence (skills/ntv-kaizen, applying kaizen files).
 * A session note is capped per section and per line, and limited to four `## ` sections (lib/session-note-cap.cjs):
 * it is current state, rewritten, never a log (rules/mine/session-notes.md); an older note gets the four
 * sections the first time it is edited. Edits that shrink an over-budget file are allowed.
 * PostToolUse(Bash): a shell write (sed -i, heredoc) is not seen before it runs, so after every
 * Bash call a rule file over budget is reported back to be cut, whichever command left it there,
 * and so is a session note that call just wrote past a cap or with a section outside the four.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const MINE_DIR = path.join(CLAUDE_DIR, 'rules', 'mine');
const NOTES_DIR = path.join(CLAUDE_DIR, 'session-notes');
const CLAUDE_MD = path.join(CLAUDE_DIR, 'CLAUDE.md');
const CHAR_BUDGETS = {
  [CLAUDE_MD]: 8200,
  [path.join(MINE_DIR, 'communication-style.md')]: 1750,
  [path.join(MINE_DIR, 'identities.md')]: 1765,
  [path.join(MINE_DIR, 'knowledge-index.md')]: 2100,
  [path.join(MINE_DIR, 'session-notes.md')]: 900,
  [path.join(MINE_DIR, 'user-profile.md')]: 1850,
};
const NEW_MINE_FILE_CHARS = 2000;
const TOTAL_CHARS = 16500;
const { NOTE_SECTIONS, strayHeadings, overCaps, newOverCaps } = require('./lib/session-note-cap.cjs');
const SECTIONS_TEXT = NOTE_SECTIONS.map((x) => `## ${x}`).join(', ');

// The longest a Bash call may run (10 min): a note written anywhere in it is still "just written".
const NOTE_FRESH_MS = 10 * 60 * 1000;

// This session's notes written in the last NOTE_FRESH_MS that pass a cap or hold a section outside
// NOTE_SECTIONS, as "name: <cap passed>" / "name: section ## X".
// Another session's note is its own business: it is reported in that session's Bash calls.
function longFreshNotes(sessionId, now = Date.now()) {
  if (!sessionId) return [];
  const out = [];
  let dirs = [];
  try { dirs = fs.readdirSync(NOTES_DIR); } catch { return out; }
  for (const d of dirs) {
    let files = [];
    try { files = fs.readdirSync(path.join(NOTES_DIR, d)).filter((f) => f.endsWith('.md')); } catch { continue; }
    for (const f of files) {
      const file = path.join(NOTES_DIR, d, f);
      let mtime = 0;
      try { mtime = fs.statSync(file).mtimeMs; } catch { continue; }
      if (now - mtime > NOTE_FRESH_MS) continue;
      const text = read(file);
      const head = (text.match(/^---\n[\s\S]*?\n---/) || [''])[0];
      if (!(head.match(/^session:.*$/m) || [''])[0].replace(/^session:/, '').split(/[,\s]+/).includes(sessionId)) continue;
      const over = overCaps(text);
      const stray = strayHeadings(text.slice(head.length));
      if (!over.length && !stray.length) continue;
      // Said once per version of the note: the same mtime is not reported again.
      const seen = path.join(os.tmpdir(), 'claude-rules-budget', `${sessionId.replace(/[^\w-]/g, '_')}.json`);
      let told = {};
      try { told = JSON.parse(fs.readFileSync(seen, 'utf8')); } catch { /* first time */ }
      if (told[file] === mtime) continue;
      told[file] = mtime;
      fs.mkdirSync(path.dirname(seen), { recursive: true });
      fs.writeFileSync(seen, JSON.stringify(told));
      out.push(over.length ? `${file}: ${over.map((v) => v.msg).join('; ')}` : `${file}: section ## ${stray.join(', ## ')}`);
    }
  }
  return out;
}

const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '');
const isMine = (f) => path.dirname(f) === MINE_DIR && f.endsWith('.md');
// The note itself (session-notes/<slug>/<name>.md), not a file kept in a note's `<name>-files/` folder.
const isNote = (f) => path.dirname(path.dirname(f)) === NOTES_DIR && f.endsWith('.md');

function ruleFiles() {
  const mine = fs.existsSync(MINE_DIR) ? fs.readdirSync(MINE_DIR).filter((f) => f.endsWith('.md')) : [];
  return [CLAUDE_MD, ...mine.map((f) => path.join(MINE_DIR, f))];
}

function contentAfter(current, tool, input) {
  if (tool === 'Write') return input.content || '';
  let s = current;
  for (const e of tool === 'MultiEdit' ? input.edits || [] : [input]) {
    if (typeof e.old_string !== 'string') continue;
    const next = e.new_string || '';
    s = e.replace_all ? s.split(e.old_string).join(next) : s.replace(e.old_string, () => next);
  }
  return s;
}

function problem(file, current, after) {
  const name = path.basename(file);
  if (isNote(file)) {
    const over = newOverCaps(current, after);
    if (over.length) {
      return `session note ${name}: ${over.map((v) => v.msg).join('; ')}. ` +
        'It is current state, not a log; an approval line is shortened, never dropped.';
    }
    const stray = strayHeadings(after.replace(/^---\n[\s\S]*?\n---/, ''));
    return stray.length
      ? `session note ${name} would hold section "## ${stray.join('", "## ')}"; a note holds only ${SECTIONS_TEXT} ` +
        '(rules/mine/session-notes.md). Rewrite it into those: an older note renames "## Trạng thái resume" to ' +
        '"## Resume" and folds its other sections into the first three.'
      : null;
  }
  if (file !== CLAUDE_MD && !isMine(file)) return null;
  const budget = CHAR_BUDGETS[file] ?? NEW_MINE_FILE_CHARS;
  if (after.length > budget && after.length > current.length) {
    return `${name} would grow to ${after.length} chars (budget ${budget}, now ${current.length}).`;
  }
  const others = ruleFiles().filter((f) => f !== file).reduce((n, f) => n + read(f).length, 0);
  const [totalBefore, totalAfter] = [others + current.length, others + after.length];
  if (totalAfter > TOTAL_CHARS && totalAfter > totalBefore) {
    return `CLAUDE.md + rules/mine would grow to ${totalAfter} chars (budget ${TOTAL_CHARS}, now ${totalBefore}).`;
  }
  return null;
}

let raw = '';
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', () => {
  try {
    const { tool_name: tool, tool_input: input = {}, hook_event_name: event } = JSON.parse(raw);
    if (event === 'PostToolUse' && tool === 'Bash') {
      const over = ruleFiles().map((f) => [f, read(f).length]).filter(([f, n]) => n > (CHAR_BUDGETS[f] ?? NEW_MINE_FILE_CHARS))
        .map(([f, n]) => `${path.basename(f)} ${n}/${CHAR_BUDGETS[f] ?? NEW_MINE_FILE_CHARS}`);
      const total = ruleFiles().reduce((n, f) => n + read(f).length, 0);
      if (total > TOTAL_CHARS) over.push(`CLAUDE.md + rules/mine ${total}/${TOTAL_CHARS}`);
      const notes = longFreshNotes(JSON.parse(raw).session_id);
      const msgs = [];
      if (over.length) msgs.push(`rule files are over budget (${over.join(', ')}). Cut them back.`);
      if (notes.length) {
        msgs.push(`session note over a cap or outside its sections (${notes.join(' | ')}). It is current state, ` +
          `read again before acting: rewrite it into ${SECTIONS_TEXT}; an approval line is shortened, never dropped; ` +
          'how-tos go into their knowledge/skill file.');
      }
      if (msgs.length) {
        process.stderr.write(`rules-budget: ${msgs.join(' Also: ')}\n`);
        process.exit(2);
      }
      process.exit(0);
    }
    if (!['Edit', 'Write', 'MultiEdit'].includes(tool) || !input.file_path) process.exit(0);
    const file = path.resolve(input.file_path.replace(/^~(?=\/)/, os.homedir()));
    const current = read(file);
    const why = problem(file, current, contentAfter(current, tool, input));
    if (why) {
      process.stderr.write(
        `rules-budget: ${why} ` +
          (isNote(file) ? '\n' : 'Cut before you add: tighten an existing sentence.\n')
      );
      process.exit(2);
    }
  } catch (_) { /* fail-open */ }
  process.exit(0);
});
