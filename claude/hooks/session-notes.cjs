#!/usr/bin/env node
'use strict';

/**
 * session-notes.cjs - surface the session note (rules/mine/session-notes.md).
 *   SessionStart compact|resume: print the note whose `session:` line holds this session id, in full;
 *   a note over a cap gets the order to fix it first. An older note over VIEW_CHARS with sections
 *   outside the four prints only its front matter, `## Đang làm`, `## Đang có hiệu lực` and
 *   `## Resume` (overCapView), with the order to rewrite it (a compact would otherwise load the
 *   whole log back).
 *   SessionStart startup|clear:  list open notes of the launch dir; delete `status: done` notes idle > 14 days.
 *   UserPromptSubmit with no note yet: a prompt carrying approval words gets a reminder naming the
 *   exact path, in any launch dir, to create one only if the prompt approves work.
 *   UserPromptSubmit with a note: a prompt carrying approval words gets "a line under
 *   `## Đang có hiệu lực` only if it approves, limits or decides; otherwise write nothing". The
 *   words also match a bare "ok", so the reminder never orders a write by itself.
 *   PostToolUse Bash with a note: a PR/MR merge/close/create or git push gets "rewrite the stale lines".
 * Always exits 0: a broken note never blocks a session.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { DECISION_RE } = require('./lib/user-intent.cjs');
const { NOTE_SECTIONS, overCaps, strayHeadings } = require('./lib/session-note-cap.cjs');
// How much of an over-cap note a compact shows; the order to Read and rewrite it comes with it.
const VIEW_CHARS = 1500;
const { dropHeredocs } = require('./lib/shell-words.cjs');

const ROOT = path.join(os.homedir(), '.claude', 'session-notes');
const KEEP_DONE_MS = 14 * 24 * 60 * 60 * 1000;
const slugify = (p) => p.replace(/[^A-Za-z0-9]/g, '-');
// Only at command position (after env prefixes like GH_TOKEN=$(...)), so the words inside a heredoc or grep do not count.
const STATE_RE =
  /(^|[;&|(\n])\s*(\w+=(\$\([^)]*\)|\S+)\s+)*(gh\s+pr\s+(merge|close|create|ready)|glab\s+mr\s+(merge|close|create|update)|git\s+(-C\s+\S+\s+)?push)\b/;

const mdFiles = (dir) => {
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => path.join(dir, f));
  } catch {
    return [];
  }
};

// Cut at the last line break before `max` chars, saying so.
const cutLines = (text, max) => {
  if (text.length <= max) return text;
  const at = text.lastIndexOf('\n', max);
  return `${text.slice(0, at > 0 ? at : max)}\n(… cut, Read the file for the rest)\n`;
};

// What a compact shows of an over-cap note, within VIEW_CHARS: front matter, `## Đang làm` and
// `## Đang có hiệu lực`, then the resume section (`## Resume`, or `## Trạng thái resume` in a note
// written before the four sections). A note without the four sections shows every line outside
// the resume section that quotes the user ("…" / “…”, its decisions) instead. `## Đã xong` is left
// out: it is re-read only to sum up a session. A `## ` inside a code fence does not end a section.
// A note with none of these shows its last VIEW_CHARS chars (latest state).
function overCapView(raw) {
  const text = raw.normalize('NFC').replace(/\r\n/g, '\n');
  const front = (text.match(/^---\n[\s\S]*?\n---\n?/) || [''])[0];
  const sections = [];
  let cur = { head: '', lines: [] };
  sections.push(cur);
  let fence = false;
  for (const line of text.slice(front.length).split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (!fence && /^## /.test(line)) { cur = { head: line, lines: [line] }; sections.push(cur); continue; }
    cur.lines.push(line);
  }
  const isResume = (x) => /^##\s+(Trạng thái resume|Resume)\s*$/iu.test(x.head);
  const resume = cutLines(sections.filter(isResume).map((x) => x.lines.join('\n').trimEnd()).join('\n\n'), VIEW_CHARS / 2);
  const live = sections.filter((x) => NOTE_SECTIONS.slice(0, 2).includes(x.head.replace(/^##\s+/, '').trim()));
  const kept = live.length
    ? live.map((x) => x.lines.join('\n').trimEnd()).join('\n\n')
    : sections.filter((x) => !isResume(x)).flatMap((x) => x.lines).filter((l) => /"[^"\n]+"|“[^”\n]+”/.test(l)).join('\n');
  const decisions = cutLines(kept, Math.max(0, VIEW_CHARS - resume.length));
  if (!resume && !decisions) {
    const tail = text.slice(-VIEW_CHARS);
    return `${front}\n(… earlier part not shown)\n${tail.slice(tail.indexOf('\n') + 1)}`;
  }
  return [front, decisions, resume].filter(Boolean).join('\n');
}

function readNote(file) {
  const text = fs.readFileSync(file, 'utf8');
  const head = {};
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  for (const line of m ? m[1].split('\n') : []) {
    const i = line.indexOf(':');
    if (i > 0) head[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { text, head };
}

try {
  const data = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  const id = data.session_id || '';
  const source = data.source || '';
  // The transcript sits in ~/.claude/projects/<launch-dir slug>/, which stays put when the shell cwd moves.
  const slug = data.transcript_path
    ? path.basename(path.dirname(data.transcript_path))
    : slugify(data.cwd || process.cwd());

  const dirs = fs.existsSync(ROOT) ? fs.readdirSync(ROOT).map((d) => path.join(ROOT, d)) : [];
  const own = dirs
    .flatMap(mdFiles)
    .map((file) => ({ file, ...readNote(file) }))
    .filter((n) => id && (n.head.session || '').split(/[,\s]+/).includes(id));

  if (data.hook_event_name === 'SessionStart') {
    if (source === 'compact' || source === 'resume') {
      for (const n of own) {
        // A note in the four sections is shown whole: its size grows with approvals and closed topics,
        // never cut, so a compact cannot drop an approval. A cap it passes comes as an order to fix.
        // Only an older, long note in other sections gets the cut view.
        const over = overCaps(n.text);
        if (!strayHeadings(n.text).length || n.text.length <= VIEW_CHARS) {
          const fix = over.length ? `It passes its caps: ${over.map((v) => v.msg).join('; ')}. Rewrite those parts first.\n` : '';
          console.log(`Session note ${n.file} - read it before acting, keep it updated:\n${fix}\n${n.text}`);
          continue;
        }
        console.log(
          `Session note ${n.file} is ${n.text.length} chars in sections outside the four, ` +
            'so only its live state is shown. Before any other step: Read the file and rewrite it within the caps in the four sections of ' +
            'rules/mine/session-notes.md (`## Đang làm`, `## Đang có hiệu lực`, `## Đã xong` one line per closed topic, ' +
            `\`## Resume\` IDs); detail stays in the session jsonl.\n\n${overCapView(n.text)}`
        );
      }
    } else {
      const open = [];
      for (const file of mdFiles(path.join(ROOT, slug))) {
        const { head } = readNote(file);
        if (head.status !== 'done') open.push(`- ${file}${head.scope ? ` (${head.scope})` : ''}`);
        else if (Date.now() - fs.statSync(file).mtimeMs > KEEP_DONE_MS) fs.unlinkSync(file);
      }
      if (open.length) {
        console.log(
          'Open session notes from earlier sessions here (status data, not approval; open one only when the user picks that work up):\n' +
            open.join('\n')
        );
      }
    }
  }

  // An approval just given, or a PR/MR state just changed, leaves the note stale unless it is written now.
  if (own.length) {
    const files = own.map((n) => n.file).join(', ');
    if (data.hook_event_name === 'UserPromptSubmit' && DECISION_RE.test(data.prompt || '')) {
      console.log(
        `If this prompt approves a block, sets a limit or decides something no artifact holds yet, write it as one line ` +
          `under "## Đang có hiệu lực" in the session note (${files}) before this turn's first tool call; if it changes topic, ` +
          'rewrite "## Đang làm" and fold the closed topic into one "## Đã xong" line. An opinion, question or acknowledgement: write nothing.'
      );
    }
    if (data.hook_event_name === 'PostToolUse' && STATE_RE.test(dropHeredocs((data.tool_input || {}).command || ''))) {
      console.log(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PostToolUse',
            additionalContext: `A PR/MR or branch state just changed: update the IDs under "## Resume" in the session note (${files}), not append; an older note: rewrite it into the four sections of rules/mine/session-notes.md first.`,
          },
        })
      );
    }
  }

  if (id && own.length === 0 && data.hook_event_name === 'UserPromptSubmit' && DECISION_RE.test(data.prompt || '')) {
    console.log(
      `This session has no note yet (rules/mine/session-notes.md). Only if this prompt approves work, ` +
        `create ${path.join(ROOT, slug)}/<yymmdd>-<topic>.md before this turn's first tool call, with front matter ` +
        `"session: ${id}", "status: open", "scope: <one line>", or append ${id} to the session: line of an open note you take over.`
    );
  }
} catch {
  // fail open
}
process.exit(0);
