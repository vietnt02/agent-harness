#!/usr/bin/env node
/**
 * tier-c-guard.cjs - PreToolUse(Bash): block a tier-C command (`airflow dags trigger/pause/unpause`,
 * `gh pr merge`, `glab mr merge`) when the user's latest words do not ask for it
 * (CLAUDE.md § Mutation gate: a question about work you hold back never opens a tier B/C step;
 * after an interrupt every tier-C step is asked again).
 * Blocks when the latest human message is a question (approval words inside a question, "sao không
 * làm luôn", do not count), or when an interrupt
 * came fewer than POST_INTERRUPT_PROMPTS prompts ago and the latest one carries no approval word.
 * Passes: an AskUserQuestion answer after that message, an approved plan of this session
 * (~/.claude/plans/<slug>/*.md with `status: approved` and this session id), bypass permissions,
 * subagents, a slash command. Fails open when the transcript cannot be read.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DECISION_RE, isQuestion, promptText } = require('./lib/user-intent.cjs');

const TAIL_BYTES = 1024 * 1024;
const POST_INTERRUPT_PROMPTS = 3;
const TIER_C = /\b(airflow\s+dags\s+(trigger|pause|unpause)|gh\s+pr\s+merge|glab\s+mr\s+merge)\b/;
const ASK_ANSWER = /(Your questions have been answered|User has answered your questions?)/;
const INTERRUPT = /^\[Request interrupted by user/;
const dropHeredocs = (s) => s.replace(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n[ \t]*\2[ \t]*(?=\n|$)/g, '<<heredoc');

function tailRecords(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n');
    if (start > 0) lines.shift();
    return lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } finally {
    fs.closeSync(fd);
  }
}

const textOf = (content) =>
  typeof content === 'string'
    ? content
    : (Array.isArray(content) ? content : [])
        .map((b) => (b.type === 'text' ? b.text : b.type === 'tool_result' ? textOf(b.content) : ''))
        .join('\n');

// Walk back from the end: { prompt, askAnswered, sinceInterrupt } for the latest human message.
function latestHuman(records) {
  let askAnswered = false;
  let prompt = null;
  let prompts = 0;
  for (let i = records.length - 1; i >= 0; i--) {
    const rec = records[i];
    const a = rec.type === 'attachment' && rec.attachment;
    let human = null;
    if (a && a.type === 'queued_command' && a.origin?.kind === 'human') human = String(a.prompt || '');
    if (rec.type === 'user' && !rec.isMeta) {
      const t = textOf(rec.message?.content).trim();
      if (INTERRUPT.test(t)) return { prompt, askAnswered, sinceInterrupt: prompts };
      if (prompt === null && ASK_ANSWER.test(t)) askAnswered = true;
      const p = promptText(rec);
      if (p !== null && !/^<(task-notification|local-command|system)/.test(p)) human = p;
    }
    if (human !== null) {
      if (prompt === null) prompt = human;
      prompts++;
      if (prompts >= POST_INTERRUPT_PROMPTS) return { prompt, askAnswered, sinceInterrupt: Infinity };
    }
  }
  return { prompt, askAnswered, sinceInterrupt: Infinity };
}

function approvedPlan(sessionId, cwd) {
  if (!sessionId) return false;
  const dirs = new Set([cwd, process.cwd()].filter(Boolean).map((p) => p.replace(/[^A-Za-z0-9]/g, '-')));
  for (const d of dirs) {
    const dir = path.join(os.homedir(), '.claude', 'plans', d);
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')); } catch { continue; }
    for (const f of files) {
      const head = fs.readFileSync(path.join(dir, f), 'utf8').slice(0, 600);
      if (/^status: approved$/m.test(head) && head.includes(sessionId)) return true;
    }
  }
  return false;
}

let raw = '';
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(raw);
    const command = dropHeredocs((data.tool_input || {}).command || '');
    if (data.tool_name !== 'Bash' || !TIER_C.test(command)) process.exit(0);
    if (data.agent_id || data.permission_mode === 'bypassPermissions' || !data.transcript_path) process.exit(0);
    const { prompt, askAnswered, sinceInterrupt } = latestHuman(tailRecords(data.transcript_path));
    if (prompt === null || askAnswered || /<command-name>/.test(prompt)) process.exit(0);
    if (approvedPlan(data.session_id, data.cwd)) process.exit(0);
    const approves = DECISION_RE.test(prompt);
    const asking = isQuestion(prompt);
    const afterInterrupt = sinceInterrupt < POST_INTERRUPT_PROMPTS && !approves;
    if (!asking && !afterInterrupt) process.exit(0);
    const quote = prompt.replace(/\s+/g, ' ').slice(0, 160);
    process.stderr.write(
      `tier-c-guard: "${TIER_C.exec(command)[0]}" is tier C, but the user's latest words ("${quote}") ` +
        (asking ? 'are a question, not a go-ahead. ' : 'come right after an interrupt. ') +
        'Answer the question first, say in one line what you would run, and ask (CLAUDE.md § Mutation gate).\n'
    );
    process.exit(2);
  } catch (_) { /* fail-open */ }
  process.exit(0);
});
