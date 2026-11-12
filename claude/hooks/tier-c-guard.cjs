#!/usr/bin/env node
/**
 * tier-c-guard.cjs - PreToolUse(Bash), two checks:
 * 1. A tier-C Airflow step (`airflow dags pause/unpause/backfill`, `airflow dags trigger` with
 *    `--conf`/`-c`) is blocked when the user's latest words do not ask for it (CLAUDE.md § Mutation
 *    gate: a question never opens a tier-C step; after an interrupt every tier-C step is asked
 *    again). A trigger on the schedule's own config is not tier C (§ Irreversible actions) and
 *    passes; a merge is judged by its deploy (§ Irreversible actions), not here.
 *    Blocks when the latest human message is a question, or when an interrupt came fewer than
 *    POST_INTERRUPT_PROMPTS prompts ago and the latest one carries no approval word. Orca's worker
 *    messages are not the user's words (lib/user-intent.cjs). Passes: an AskUserQuestion answer after
 *    that message, an approved plan of this session (~/.claude/plans/<slug>/*.md with
 *    `status: approved` and this session id), bypass permissions, subagents, a slash command.
 * 2. A production write (`cf … update|create|delete…`, `wrangler deploy`, `gh pr merge`, `glab mr
 *    merge`) after another step in the same call is always blocked: `a | tail && cf …` runs the
 *    write even when `a` failed (a pipe returns its last command's status), so it runs alone.
 * Fails open when the transcript cannot be read.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DECISION_RE, isQuestion, promptText } = require('./lib/user-intent.cjs');
const { commands, program, innerScript, assignments } = require('./lib/shell-words.cjs');

const TAIL_BYTES = 1024 * 1024;
const POST_INTERRUPT_PROMPTS = 3;
const TIER_C = /\bairflow\s+dags\s+(pause|unpause|backfill)\b|\bairflow\s+dags\s+trigger\b[^;&|'"\n]*?\s(-c|--conf)(\s|=)/;
const ASK_ANSWER = /(Your questions have been answered|User has answered your questions?)/;
const INTERRUPT = /^\[Request interrupted by user/;
const dropHeredocs = (s) => s.replace(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n[ \t]*\2[ \t]*(?=\n|$)/g, '<<heredoc');

// A production write this hook knows, as one simple command's words (after program()). `npx`-style
// runners are unwrapped; global flags before the verbs are skipped with their value, then verbs are
// read up to the next flag, so a flag value never counts.
const PROD_VERBS = {
  cf: /^(update|edit|create|delete|put|patch|set|rm|remove|deploy|publish|purge)$/,
  wrangler: /^(deploy|publish|put|delete|execute|create|apply|rollback|bulk)$/,
};
const RUNNERS = { npx: 1, bunx: 1, pnpm: 1, yarn: 1, npm: 1 };
const RUNNER_VALUE = /^(--filter|-F|-C|--dir|--prefix|-w|--workspace|-p|--package)$/;
function verbsOf(args) {
  let i = 0;
  while (i < args.length && args[i].startsWith('-')) i += /=/.test(args[i]) ? 1 : 2;
  const rest = args.slice(i);
  const flag = rest.findIndex((a) => a.startsWith('-'));
  return flag < 0 ? rest : rest.slice(0, flag);
}
function prodWrite(words) {
  let [cmd, ...args] = words;
  if (RUNNERS[cmd]) {
    while (args.length && (args[0].startsWith('-') || /^(exec|dlx|run|x)$/.test(args[0]))) args = args.slice(RUNNER_VALUE.test(args[0]) ? 2 : 1);
    [cmd, ...args] = args;
    cmd = String(cmd || '').replace(/(.)@.*$/, '$1');
  }
  const verbs = verbsOf(args);
  if (PROD_VERBS[cmd]) return verbs.some((w) => PROD_VERBS[cmd].test(w));
  return (cmd === 'gh' && verbs[0] === 'pr' && verbs[1] === 'merge') || (cmd === 'glab' && verbs[0] === 'mr' && verbs[1] === 'merge');
}

// The first production write that runs after another step of the same shell (a `cd`, an assignment
// or `set` before it is no step; nor a `$(…)` feeding the write or an assignment, such as
// `GH_TOKEN=$(gh auth token) gh pr merge`), as its text; null when each one runs alone. A second
// production write counts the first as a step. Each `(…)` / `$(…)` is read the same way on its own.
function chainedProdWrite(command) {
  const all = commands(command);
  const scopes = [...new Set(all.map((r) => String(r.scope)))];
  for (const scope of scopes) {
    const hit = scanScope(all, scope);
    if (hit) return hit;
  }
  return null;
}
function scanScope(all, scope) {
  let before = false;
  let pending = false; // a direct child `$(…)` / `(…)` not yet known to feed the next command
  for (const raw of all) {
    const sc = String(raw.scope);
    if (sc !== scope) {
      if (sc.startsWith(`${scope}.`)) pending = true;
      continue;
    }
    const words = program(raw);
    if (pending && !raw.some((w) => /\$\(|`/.test(w))) before = true;
    pending = false;
    const script = innerScript(words);
    if (script !== null) {
      const inner = chainedProdWrite(script);
      if (inner) return inner;
      if (before && commands(script).map(program).some(prodWrite)) return words.join(' ');
      before = true;
      continue;
    }
    if (prodWrite(words)) {
      if (before) return words.join(' ');
      before = true;
      continue;
    }
    if (!words.length || assignments(raw) || ['cd', 'pushd', 'set', 'export', 'true', ':'].includes(words[0])) continue;
    before = true;
  }
  return null;
}

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

module.exports = { chainedProdWrite, latestHuman };
if (require.main !== module) return;

let input = '';
process.stdin.on('data', (c) => (input += c));
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input);
    const raw = String((data.tool_input || {}).command || '');
    if (data.tool_name !== 'Bash' || data.agent_id) process.exit(0);
    const chained = chainedProdWrite(raw);
    if (chained) {
      process.stderr.write(
        `tier-c-guard: \`${chained.slice(0, 120)}\` writes to production after another step in the same call. ` +
          'A failed step before it can still let it run (a pipe returns its last command\'s status). ' +
          'Run the earlier steps, read their output, then run the write alone in its own call.\n'
      );
      process.exit(2);
    }
    const command = dropHeredocs(raw);
    if (!TIER_C.test(command)) process.exit(0);
    if (data.permission_mode === 'bypassPermissions' || !data.transcript_path) process.exit(0);
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
