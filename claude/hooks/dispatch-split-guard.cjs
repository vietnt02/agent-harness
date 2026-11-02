#!/usr/bin/env node
/**
 * dispatch-split-guard.cjs - PreToolUse(Bash): `orca orchestration worker-start` is blocked until
 * the command (a `# Track:` comment line or its description) or visible text of this turn holds a
 * `Track:` line per worker, listing each task with the files it
 * touches: `Track: w17 ← sửa chốt [gui/chot.py, giao_dien.py] | tắt backend [app.py]`.
 * A worker given ≥2 tasks whose file sets do not chain through a shared source file is blocked: they are
 * separate tracks for separate workers (skills/ntv-orca/SKILL.md Rule 5). Test, doc, plan and fixture files
 * never link tasks: a shared test suite is not a shared file. The user's request for serial work or memory pressure is written on the line as
 * `(serial: <lý do>)`; it counts only when one of the user's last 10 prompts asks for it ("chạy serial",
 * "làm tuần tự"; not a complaint, a negation, a question or "serial number") or
 * `kern.memorystatus_vm_pressure_level` is ≥2 (`DSG_PRESSURE` overrides it in tests). A single task whose
 * files sit under ≥3 top-level roots is blocked with no escape: groups that truly edit one shared source
 * file list it in each group and chain into one track. A command whose every worker-start is `--retry-of`
 * is exempt.
 * An antigravity worker started without `--effort` is blocked, `--retry-of` included: agy then runs
 * Medium, not the High ntv-orca coordinator-rules.md (Rule 18) requires. `--terminal` reuses a running agy.
 * A claude worker whose `--model` is not a bare alias (opus, sonnet, fable, haiku) is blocked unless the
 * command holds a `# Model: user chỉ định <bản>` line: a full id outside Orca's catalog drops the
 * worker's `Approve for me` permission mode (ntv-orca Rule 18). A claude worker at all needs a
 * `# Model: <lý do>` line, `--retry-of` exempt: a medium task goes to gemini-flash, then gpt-luna
 * (Rule 18), and the manifest's model column is written before that rule is in view.
 * `worker-start --help` is not a dispatch.
 * Text written right before a tool call is stored as a paraphrased `narration` thinking block, so the
 * line is reliable only inside the call itself; the transcript is read too, for text ending a turn.
 * Subagents are skipped. Fails open.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { toSlash, expandHome } = require('./lib/platform.cjs');

const TAIL_BYTES = 512 * 1024;
const WAIT_MS = 1500;
const POLL_MS = 100;

const DISPATCH = /(?:^|[;&|({\n]\s*|\b(?:then|do)\s+)(?:\w+=\S*\s+)*orca\s+orchestration\s+worker-start\b/;

const BARE_CLAUDE = /^(opus|sonnet|fable|haiku)$/;
// Files that never link two tasks into one track: a shared test suite, doc, plan or fixture is not
// a shared source file.
const NOT_A_LINK = /(^|\/)(tests?|__tests__|spec|specs|fixtures?|testdata|e2e|__snapshots__|cypress|docs?|plans?)\/|\.(test|spec|tests)\.|_test\.\w+$|(^|\/)test[-_]|(^|\/)conftest\.py$|(^|\/)(vitest|jest)\.config\.|\.(md|txt|rst)$/i;
const { promptText, isQuestion } = require('./lib/user-intent.cjs');
const RECENT_PROMPTS = 10;

// Did one of the user's latest prompts ask for serial work? A request ("chạy serial", "làm tuần tự",
// a bare "serial" answering the mode ask), never a complaint, a negation, a question or "serial number".
function userAskedSerial(lines) {
  const prompts = [];
  for (let i = lines.length - 1; i >= 0 && prompts.length < RECENT_PROMPTS; i--) {
    if (!lines[i].includes('"type":"user"')) continue;
    let rec; try { rec = JSON.parse(lines[i]); } catch (_) { continue; }
    const t = promptText(rec);
    // Pasted text is someone else's words, not the user's request.
    if (t !== null) prompts.push(t.replace(/<pasted_content[^>]*>[\s\S]*?<\/pasted_content[^>]*>/g, ' ').normalize('NFC'));
  }
  return prompts.some((t) => t.split(/[.!?;\n]+/).some((c) => {
    const clause = c.trim().toLowerCase();
    if (!/serial|tuần tự/.test(clause) || /serial\s+(number|no\b|port|key)/.test(clause)) return false;
    // A question or a complaint ("sao cứ giao … serial thế"), or a negation before the word.
    if (isQuestion(clause) || /(^|\s)sao(\s|$)|\s(thế|vậy)$/.test(clause) ||
      /(không|đừng|chứ)\s+(\S+\s+){0,3}(serial|tuần tự)/.test(clause)) return false;
    return /^(serial|tuần tự)$/.test(clause) || /(chạy|làm|giao|dispatch|để)\s+(\S+\s+){0,3}(serial|tuần tự)/.test(clause);
  }));
}
function memoryPressure() {
  if (process.env.DSG_PRESSURE) return Number(process.env.DSG_PRESSURE);
  if (process.platform !== 'darwin') return 1;
  try { return Number(execFileSync('sysctl', ['-n', 'kern.memorystatus_vm_pressure_level'], { encoding: 'utf8', timeout: 2000 }).trim()) || 1; } catch (_) { return 1; }
}
// `(serial: …)` on the line, backed by the user's request or by memory pressure.
const serialOk = (line, ctx) => /\(serial:\s*\S/.test(line) && (ctx.serial() || ctx.pressure() >= 2);

// The command with heredoc bodies and comment lines dropped (they are not commands), and its
// `worker-start` segments.
function workerStarts(command) {
  const cmd = command.replace(/(<<-?\s*(['"]?)(\w+)\2[^\n]*)\n[\s\S]*?\n[ \t]*\3[ \t]*(?=\n|$)/g, '$1')
    .replace(/\\\n/g, ' ').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n')
    .replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, (q) => q.replace(/[;&|\n]/g, ' '));
  return { cmd, segs: cmd.split(/[;&|\n]/).filter((seg) => /\borca\s+orchestration\s+worker-start\b/.test(seg)) };
}

const onlyHelp = (segs) => segs.length > 0 && segs.every((seg) => /\s(--help|-h)\b/.test(seg));

// A `worker-start --agent antigravity` segment with no `--effort`. A segment forwarding "$@" takes
// its flags from the call site, so the whole command is searched for it.
function missingEffort({ cmd, segs }) {
  const hasEffort = (s) => /--effort[ =]['"]?[^\s'"]/.test(s);
  return segs.some((seg) => /--agent[ =]['"]?antigravity\b/.test(seg) && !/--terminal\b/.test(seg) &&
    !hasEffort(/\$\{?[@*]/.test(seg) ? cmd : seg));
}

// The `--model` of a `worker-start --agent claude` segment that is not a bare alias, unless the
// command names the user's pick on a `# Model: user chỉ định <bản>` line. A `$var` is not judged.
function unpinnedClaudeModel(command, { segs }) {
  if (/^\s*#\s*Model:\s*user chỉ định\s+\S/m.test(command)) return null;
  for (const seg of segs) {
    if (!/--agent[ =]['"]?claude\b/.test(seg)) continue;
    const m = seg.match(/--model[ =]['"]?([^\s'"]+)/);
    if (m && !m[1].startsWith('$') && !BARE_CLAUDE.test(m[1])) return m[1];
  }
  return null;
}

// A `worker-start --agent claude` segment, not a retry, with no `# Model: <lý do>` line in the command.
function claudeWithoutReason(command, { segs }) {
  if (/^\s*#\s*Model:\s*\S/m.test(command)) return false;
  return segs.some((seg) => /--agent[ =]['"]?claude\b/.test(seg) && !/--retry-of\b/.test(seg));
}

function tailLines(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n');
    if (start > 0) lines.shift();
    return lines;
  } finally {
    fs.closeSync(fd);
  }
}

// `Track:` lines in visible assistant text since the user's latest prompt (task notifications skipped).
function trackLines(lines) {
  const found = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    let rec;
    try { rec = JSON.parse(lines[i]); } catch { continue; }
    const content = rec.message?.content;
    if (rec.type === 'user' && typeof content === 'string' && !content.startsWith('<task-notification>')) break;
    if (rec.type !== 'assistant' || !Array.isArray(content)) continue;
    for (const b of content) {
      if (b.type !== 'text') continue;
      for (const l of b.text.split('\n')) if (/^\W*Track:/.test(l)) found.push(l);
    }
  }
  return found;
}

// Top-level root of a task file ("." for a file at the repo root); an absolute or `~/` path is
// taken relative to its git toplevel. null when that root cannot be found.
function rootOf(file) {
  let p = toSlash(file).replace(/^\.\//, '');
  if (p.startsWith('~/')) p = toSlash(path.join(os.homedir(), p.slice(2)));
  if (path.isAbsolute(p)) {
    let dir = path.dirname(p);
    while (!fs.existsSync(dir) && dir !== path.dirname(dir)) dir = path.dirname(dir);
    try {
      p = toSlash(path.relative(execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'],
        { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).trim(), p));
    } catch (_) { return null; }
  }
  return p.includes('/') ? `${p.split('/')[0]}/` : '.';
}

// Any task on the line whose files sit under >=3 top-level roots: a bundle hidden in one bracket,
// where unrelatedTasks() cannot see it. No escape: a task that truly shares a source file is written
// as sub-tasks that each list that file, and unrelatedTasks() checks the chain. Returns the roots, or null.
function sprawlingTask(line) {
  for (const [, files] of line.matchAll(/\[([^\]]*)\]/g)) {
    // A path outside any repo is its own root, not dropped.
    const roots = new Set(files.split(',').map((f) => f.trim()).filter(Boolean).map((f) => rootOf(f) || f));
    if (roots.size >= 3) return [...roots];
  }
  return null;
}

// Tasks on one line that share no source file chain with the first task; empty when the line is one track.
function unrelatedTasks(line, ctx) {
  if (serialOk(line, ctx)) return [];
  const tasks = [...line.matchAll(/([^|←\[\]]*)\[([^\]]*)\]/g)].map((m) => ({
    name: m[1].trim(),
    files: new Set(m[2].split(',').map((f) => toSlash(f.trim())).filter((f) => f && !NOT_A_LINK.test(f))),
  }));
  if (tasks.length < 2) return [];
  const linked = new Set([0]);
  for (let grew = true; grew; ) {
    grew = false;
    tasks.forEach((t, i) => {
      if (linked.has(i)) return;
      if ([...linked].some((j) => [...t.files].some((f) => tasks[j].files.has(f)))) {
        linked.add(i);
        grew = true;
      }
    });
  }
  return tasks.filter((_, i) => !linked.has(i)).map((t) => t.name);
}

function verdict(lines, input, ctx) {
  const own = `${input.command || ''}\n${input.description || ''}`.split('\n').filter((l) => /^\W*Track:/.test(l));
  const tracks = [...own, ...trackLines(lines)];
  if (!tracks.length) {
    return 'no `Track:` line. Put one per worker in the command as a comment line, above the call: ' +
      '`# Track: <wN> ← <task> [file, file] | <task> [file]` (text written before a call is not kept verbatim).';
  }
  for (const line of tracks) {
    const serialNote = /\(serial:\s*\S/.test(line) && !serialOk(line, ctx)
      ? ' `(serial: …)` does not count: none of the user\'s latest prompts asks for serial work ("chạy serial", "làm tuần tự") and memory pressure is below 2.' : '';
    const roots = sprawlingTask(line);
    if (roots) {
      return `\`${line.trim()}\` gives a task files under ${roots.join(', ')}: name each file group as its own ` +
        'task (`| task [files]`), so unrelated groups go to separate workers, each on its own branch; the ' +
        'coordinator merges them into an integration branch and runs the shared tests there (ntv-orca Rule 5). ' +
        'Groups that truly edit one shared source file list that file in each group, and stay one track. ' +
        'A shared test, doc, plan or fixture file does not link groups.';
    }
    const split = unrelatedTasks(line, ctx);
    if (split.length) {
      return `\`${line.trim()}\` bundles tasks that share no source file (${split.join(', ')}): give each its own ` +
        'worker, dispatched now (ntv-orca Rule 5); shared test, doc, plan or fixture files do not count. Only the ' +
        'user\'s request for serial work or memory pressure ≥2 keeps them together, written on the line as ' +
        '`(serial: <lý do>)`.' + serialNote;
    }
  }
  return null;
}

module.exports = { rootOf, unrelatedTasks, sprawlingTask, verdict, workerStarts };
if (require.main !== module) return;

let raw = '';
process.stdin.on('data', (c) => (raw += c));
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

process.stdin.on('end', () => {
  try {
    const { transcript_path: transcript, agent_id: agentId, tool_input: input } = JSON.parse(raw);
    const command = String(input?.command || '');
    if (!transcript || agentId || !DISPATCH.test(command)) process.exit(0);
    const starts = workerStarts(command);
    if (onlyHelp(starts.segs)) process.exit(0);
    const model = unpinnedClaudeModel(command, starts);
    if (model) {
      process.stderr.write(`dispatch-split-guard: a claude worker takes a bare alias (\`--model opus\`, sonnet, ` +
        `fable, haiku), not \`${model}\` (ntv-orca Rule 18): an id outside Orca's catalog drops the worker's ` +
        '`Approve for me` mode. A version the user named: add a `# Model: user chỉ định <bản>` line.\n');
      process.exit(2);
    }
    if (claudeWithoutReason(command, starts)) {
      process.stderr.write('dispatch-split-guard: a claude worker needs a `# Model: <lý do>` line in the command. ' +
        'A medium task goes to `gemini-flash`, and to `gpt-luna` only when flash is out of quota (ntv-orca Rule 18); ' +
        'claude only when its column pick wins or the user named it.\n');
      process.exit(2);
    }
    if (missingEffort(starts)) {
      process.stderr.write('dispatch-split-guard: an antigravity worker needs a bare slug plus `--effort`, ' +
        'e.g. `--model gemini-3.8-flash --effort high` (ntv-orca coordinator-rules.md, Rule 18); without it agy ' +
        'runs Medium. A model with one level gets exactly that level (`agy models`).\n');
      process.exit(2);
    }
    if (starts.segs.every((seg) => /\s--retry-of\b/.test(seg))) process.exit(0);
    const once = (f) => { let v; return () => (v === undefined ? (v = f()) : v); };
    const ctx = { serial: once(() => userAskedSerial(tailLines(transcript))), pressure: once(memoryPressure) };
    let problem = verdict(tailLines(transcript), input, ctx);
    for (let waited = 0; problem && waited < WAIT_MS; waited += POLL_MS) {
      sleep(POLL_MS);
      problem = verdict(tailLines(transcript), input, ctx);
    }
    if (problem) {
      process.stderr.write(`dispatch-split-guard: ${problem}\n`);
      process.exit(2);
    }
  } catch (_) { /* fail-open */ }
  process.exit(0);
});
