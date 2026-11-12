#!/usr/bin/env node
/**
 * dispatch-split-guard.cjs - PreToolUse(Bash): checks on `orca orchestration worker-start`. Blocks only
 * what spoils a worker's whole run or hands it a production write; how the work was split is a nudge.
 * Nudge (context back, the worker starts): a `Track:` line (in the command as a `# Track:` comment or
 * its description, or in visible text of this turn) listing each task with the files it touches,
 * `Track: w17 ← sửa chốt [gui/chot.py, giao_dien.py] | tắt backend [app.py]`, whose tasks share no
 * source file, or whose one task spans ≥3 top-level roots: separate tracks for separate workers next
 * time (skills/ntv-orca/SKILL.md § 2, Song song và cap). Test, doc, plan and fixture files never link
 * tasks. `(serial: <lý do>)` on the line silences it when one of the user's last 10 prompts asks for
 * serial work ("chạy serial", "làm tuần tự"; not a complaint, a negation, a question or "serial
 * number") or `kern.memorystatus_vm_pressure_level` is ≥2 (`DSG_PRESSURE` overrides it in tests). No
 * `Track:` line, or a command whose every worker-start is `--retry-of`: nothing said.
 * Said once (lib/block-once.cjs; the same command run again passes): an antigravity worker started
 * without `--effort` (`--retry-of` included: agy then runs Medium, not the High ntv-orca § 2 (Chọn
 * model) requires; `--terminal` reuses a running agy), and a claude worker whose `--model` is not a
 * bare alias (opus, sonnet, fable, haiku): a full id outside Orca's catalog drops the worker's
 * `Approve for me` permission mode (ntv-orca § 2, Chọn model).
 * A new spec (a dispatch's `--spec`/`--spec-file`, or a `task-create`) that never asks the worker to run
 * `orca orchestration check --peek` (a negated mention does not count) gets a nudge: before Orca 1.4.249
 * a Chat worker saw a coordinator's `send` only after its turn ended, and on another agent or version
 * it may still, so the spec's inbox check is what makes a correction land mid-turn everywhere. A `--task` dispatch brings a Task whose
 * spec `task-create` brought; a spec this hook cannot read (`$var` path, stdin) is not judged.
 * Only a simple command that runs `worker-start` is a dispatch, not the words inside a quoted string.
 * `worker-start --help` is not a dispatch.
 * A spec or message the coordinator hands a worker (`worker-start`, `task-create`, `send`, `reply`,
 * `dispatch`) that holds a Lark or n8n production write is blocked: a worker only scouts, builds the
 * command and dry-runs it; the coordinator runs it (ntv-implement § Who works). A write is a
 * `lark-cli <domain> +<shortcut>` whose name holds no read verb (get, list, search…), a bare
 * `+<object>-<write verb>`, `lark-cli api POST|PUT|PATCH|DELETE`, or an n8n tool that changes or
 * runs a workflow (`n8n_create_*`, `n8n_update_*`, `n8n_delete_*`, `n8n_test_*`, `n8n_autofix_*`).
 * A line passes when it holds `--dry-run`, or a negated run verb ("không chạy", "đừng gọi", "do not
 * run") before the write. The text is the command plus `--spec-file` and `$(cat <file>)`, resolved
 * after a leading `cd <dir> &&`. A `# Prod-write: "<câu của user>"` line passes it when that sentence
 * (a write or permission word in it) is in one of the user's last 10 prompts. An Orca worker session
 * is not judged (its reports carry commands for the coordinator). The write found, a transcript that
 * cannot be read blocks. Limit: a DB write (SQL), curl, a job trigger or a spec built another way is
 * not seen.
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

// A command handing a worker text to act on: a spec, a message, an answer to its `ask`.
const TO_WORKER = /(?:^|[;&|({\n]\s*|\b(?:then|do)\s+)(?:\w+=\S*\s+)*orca\s+orchestration\s+(?:worker-start|task-create|send|reply|dispatch)\b/;
// Text that runs nothing dropped: an escaped character, a single-quoted string (scanned left to
// right, so a `'` inside "…" opens none).
const inert = (t) => t.replace(/\\[\s\S]|'[^']*'|"(?:[^"\\]|\\.)*"/g,
  (m) => (m[0] === '\\' ? '' : m[0] === "'" ? "''" : m.replace(/\\[\s\S]/g, '')));
// A backtick dispatch is looked for in the command without heredoc bodies and comments.
const toWorker = (command) => TO_WORKER.test(command) ||
  /`\s*(?:\w+=\S*\s+)*orca\s+orchestration\s+(?:worker-start|task-create|send|reply|dispatch)\b/.test(inert(workerStarts(command).cmd));
// Orca's dispatch brief opens a worker session with this line.
// A simple command that runs `orca orchestration worker-start` (not a mention of it inside a quoted string).
const STARTS_WORKER = /^[\s({]*(?:(?:then|do|else)\s+)?(?:\w+=\S*\s+)*orca\s+orchestration\s+worker-start\b/;
const CREATES_TASK = /^[\s({]*(?:(?:then|do|else)\s+)?(?:\w+=\S*\s+)*orca\s+orchestration\s+task-create\b/;
// The same command run inside a command substitution: `D=$(orca … worker-start …)`, `` `orca …` ``.
const SUBST = (verb) => new RegExp(String.raw`(?:\$\(|\`)\s*(?:\w+=\S*\s+)*orca\s+orchestration\s+${verb}\b`);
const runs = (lead, verb) => (seg) => lead.test(seg) || SUBST(verb).test(inert(seg));
const startsWorker = runs(STARTS_WORKER, 'worker-start');
const createsTask = runs(CREATES_TASK, 'task-create');
const DISPATCH_LEAD = 'Please carry out this task from my Orca coordinator';
// A lark-cli shortcut is a read when one segment of its name is a read verb.
const LARK_READ = new Set(['get', 'list', 'search', 'fetch', 'download', 'preview', 'query', 'read', 'show',
  'detail', 'status', 'diff', 'agenda', 'export', 'info', 'view', 'watch', 'consume', 'subscribe', 'options']);
const LARK_SHORTCUT = /\blark-cli\s+[a-z][\w-]*\s+(?:[^\n]{0,400}?\s)?\+([a-z][\w-]*)/gi;
// Writes that need no lark-cli prefix: a bare `+<object>-<write verb>`, a raw `lark-cli api` write,
// an n8n tool that changes or runs a workflow (also under its `mcp__…__` name).
const PROD_WRITE = new RegExp([
  // Not at a line start: a diff line opens with `+`.
  /[\s`'"(]\+[a-z][\w]*(?:-[\w]+)*-(?:create|update|delete|upsert|move|copy|rename|bind|unbind|enable|disable|send|reply|forward|upload|import|arrange|patch|replace|set|add|remove|publish|transfer|clear|merge|submit|edit|revert|put|insert|complete|assign|sync|push)\b/.source,
  /\blark-cli\s+api\s+(?:--?\S+(?:\s+[^-\s]\S*)?\s+){0,8}(?:POST|PUT|PATCH|DELETE)\b/.source,
  /(?:^|[^a-z0-9])n8n_(?:create|update|delete|test|autofix|deploy|trigger|manage)_?\w*/.source,
  /(?:^|[^a-z0-9])n8n_(?:workflow_versions|executions)\b[^\n]{0,200}?\b(?:rollback|delete|prune)\b/.source,
].join('|'), 'i');
// A run verb negated, with no sentence break before the write: "không chạy", "đừng gọi", "do not run".
const NEGATED_RUN = /(?:^|[^\p{L}])(?:không|đừng|cấm|never|do not|don't|must not)\s+(?:được\s+)?(?:tự\s+)?(?:chạy|gọi|ghi|thực thi|dùng|run|call|execute|use|invoke)(?=$|[^\p{L}])[^.,:;!?\n]*$/iu;

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
// `worker-start` segments. Separators inside quotes do not split a segment: they become spaces, or
// with `keep` stand-in characters that `restore` turns back (a spec's own `;` and line breaks), and
// each heredoc's opening line marked with the index of its body in `bodies`.
const STAND_IN = { ';': '\u0001', '&': '\u0002', '|': '\u0003', '\n': '\u0004' };
const restore = (t) => t.replace(/[\u0001-\u0004]/g, (c) => Object.keys(STAND_IN).find((k) => STAND_IN[k] === c));
function workerStarts(command, keep = false) {
  const bodies = [];
  const cmd = command.replace(/(<<-?\s*(['"]?)(\w+)\2[^\n]*)\n([\s\S]*?)\n[ \t]*\3[ \t]*(?=\n|$)/g,
    (_, open, q, tag, body) => (keep ? `${open}\u0005${bodies.push(body) - 1}\u0005` : open))
    .replace(/\\\n/g, ' ').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n')
    .replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, (q) => q.replace(/[;&|\n]/g, (c) => (keep ? STAND_IN[c] : ' ')));
  return { cmd, bodies, segs: cmd.split(/[;&|\n]/).filter(startsWorker) };
}

const onlyHelp = (segs) => segs.length > 0 && segs.every((seg) => /\s(--help|-h)\b/.test(seg));

// A `worker-start --agent antigravity` segment with no `--effort`. A segment forwarding "$@" takes
// its flags from the call site, so the whole command is searched for it.
function missingEffort({ cmd, segs }) {
  const hasEffort = (s) => /--effort[ =]['"]?[^\s'"]/.test(s);
  return segs.some((seg) => /--agent[ =]['"]?antigravity\b/.test(seg) && !/--terminal\b/.test(seg) &&
    !hasEffort(/\$\{?[@*]/.test(seg) ? cmd : seg));
}

// The `--model` of a `worker-start --agent claude` segment that is not a bare alias. A `$var` is not judged.
function unpinnedClaudeModel(command, { segs }) {
  for (const seg of segs) {
    if (!/--agent(?:\s+|=)['"]?claude\b/.test(seg)) continue;
    const m = seg.match(/--model[ =]['"]?([^\s'"]+)/);
    if (m && !m[1].startsWith('$') && !BARE_CLAUDE.test(m[1])) return m[1];
  }
  return null;
}

// Text a worker will receive from this command: the command itself (comment lines of this hook's
// own markers dropped), plus every `--spec-file <path>` and `$(cat <path>)` / `$(< <path>)` it reads.
function workerText(command, cwd) {
  const parts = [command.split('\n').filter((l) => !/^\s*#\s*(Gate|Track|Model|Prod-write):/.test(l)).join('\n')];
  const PATH = String.raw`(?:"([^"]+)"|'([^']+)'|([^\s'")]+))`;
  const pick = (m) => m[1] ?? m[2] ?? m[3];
  // A leading `cd <dir> &&` moves where relative paths resolve.
  let base = cwd || process.cwd();
  for (const m of command.matchAll(new RegExp(String.raw`(?:^|[;&|\n]\s*)cd\s+${PATH}\s*(?:&&|;)`, 'g'))) {
    base = path.resolve(base, expandHome(pick(m)));
  }
  const files = [...command.matchAll(new RegExp(String.raw`--spec-file[ =]${PATH}`, 'g')),
    ...command.matchAll(new RegExp(String.raw`\$\(\s*(?:cat\s+|<\s*)${PATH}`, 'g'))]
    .map(pick).filter((f) => f && f !== '-' && !f.startsWith('$'));
  for (const f of files) {
    const abs = path.resolve(base, expandHome(f));
    try { parts.push(fs.readFileSync(abs, 'utf8')); } catch (_) { /* unreadable: nothing to judge */ }
  }
  return parts.join('\n');
}

// True when the text asks for a mid-turn inbox read: a sentence holding `check … --peek` with no
// negation before it in that sentence ("đừng chạy … check --peek" does not count).
function readsInbox(text) {
  return String(text).split(/[.\n;]+/).some((sentence) => {
    const at = sentence.search(/\bcheck\b[^.\n;]*--peek\b/);
    return at >= 0 && !/(?:^|[^\p{L}])(?:đừng|không|chớ|do not|don't|never)(?![\p{L}])/iu.test(sentence.slice(0, at));
  });
}

// The spec each segment that creates work hands a worker: a `task-create`, or a dispatch that is not
// `--task` (that one runs a Task whose spec `task-create` already brought). Each item is the spec
// text (a `$(cat <<TAG …)` heredoc read from the command), or null when it cannot be read here
// (`$var`, `--spec-file -`, unreadable file, another substitution): then nothing is judged (fail-open).
function newSpecs(command, cwd) {
  const { cmd, segs, bodies } = workerStarts(command, true);
  const all = cmd.split(/[;&|\n]/).filter(createsTask);
  let base = cwd || process.cwd();
  const PATH = String.raw`(?:"([^"]+)"|'([^']+)'|([^\s'")]+))`;
  const pick = (m) => m[1] ?? m[2] ?? m[3];
  for (const m of command.matchAll(new RegExp(String.raw`(?:^|[;&|\n]\s*)cd\s+${PATH}\s*(?:&&|;)`, 'g'))) {
    base = path.resolve(base, expandHome(pick(m)));
  }
  const read = (f) => {
    if (!f || f === '-' || f.startsWith('$')) return null;
    try { return fs.readFileSync(path.resolve(base, expandHome(f)), 'utf8'); } catch (_) { return null; }
  };
  return [...segs.filter((seg) => !/\s--task(?:[ =]|$)/.test(seg) && !/\s(--help|-h)\b/.test(seg)), ...all].map((seg) => {
    const file = seg.match(new RegExp(String.raw`--spec-file[ =]${PATH}`));
    if (file) return read(pick(file));
    const inline = seg.match(/--spec[ =](?:"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+))/);
    if (!inline) return null;
    const text = restore(inline[1] ?? inline[2] ?? inline[3]);
    if (!text.startsWith('$')) return text;
    const here = text.match(/^\$\(\s*cat\s*<<-?\s*(['"]?)\w+\1[^\u0005]*\u0005(\d+)\u0005/);
    if (here) return bodies[Number(here[2])] ?? null;
    const cat = text.match(new RegExp(String.raw`^\$\(\s*(?:cat\s+|<\s*)${PATH}\s*\)$`));
    return cat ? read(pick(cat)) : null;
  });
}

// Lines of the worker's text that run a production write for real.
function prodWrites(text) {
  return text.split('\n').map((l) => l.trim()).filter((l) => {
    let at = -1;
    for (const m of l.matchAll(LARK_SHORTCUT)) {
      if (!m[1].toLowerCase().split('-').some((seg) => LARK_READ.has(seg))) { at = m.index; break; }
    }
    const w = l.match(PROD_WRITE);
    if (w && (at < 0 || w.index < at)) at = w.index;
    // `--dry-run` counts only on the write itself, after it on the line, not as a word before it.
    return at >= 0 && !NEGATED_RUN.test(l.slice(0, at)) && !/--dry-run\b/.test(l.slice(at));
  });
}

// Is this transcript an Orca worker's session? Its first prompt opens with the dispatch brief.
function workerSession(lines) {
  for (const line of lines) {
    if (!line.includes('"type":"user"')) continue;
    let rec; try { rec = JSON.parse(line); } catch (_) { continue; }
    const t = promptText(rec);
    if (t !== null) return t.trimStart().startsWith(DISPATCH_LEAD);
  }
  return false;
}

// The user's quoted sentence on a `# Prod-write: "…"` line, when one of their last prompts holds it.
function prodWriteAllowed(command, lines) {
  const m = command.match(/^\s*#\s*Prod-write:\s*["“]([^"”]{12,})["”]/m);
  if (!m) return false;
  const quote = m[1].normalize('NFC').trim().toLowerCase();
  // The sentence must grant something: a write or permission word.
  const GRANT = /(?:^|[^\p{L}])(ghi|chạy|sửa|xoá|xóa|gửi|cho phép|được phép|write|run|update|delete|send|allow)(?=$|[^\p{L}])/iu;
  if (!GRANT.test(quote)) return false;
  // A negated grant ("đừng ghi …", "không cho phép …") is a prohibition, not a permission.
  if (/(?:^|[^\p{L}])(?:không|đừng|cấm|chưa|never|do not|don't|must not)\s+(?:\S+\s+){0,2}?(?:ghi|chạy|sửa|xoá|xóa|gửi|cho phép|được phép|write|run|update|delete|send|allow)(?=$|[^\p{L}])/iu.test(quote)) return false;
  let seen = 0;
  for (let i = lines.length - 1; i >= 0 && seen < RECENT_PROMPTS; i--) {
    if (!lines[i].includes('"type":"user"')) continue;
    let rec; try { rec = JSON.parse(lines[i]); } catch (_) { continue; }
    const t = promptText(rec);
    if (t === null) continue;
    seen++;
    // Pasted text is someone else's words, not the user's permission.
    const own = t.replace(/<pasted_content[^>]*>[\s\S]*?<\/pasted_content[^>]*>/g, ' ').normalize('NFC').toLowerCase();
    // The quote is a whole clause of the prompt, not a cut from one.
    const clauses = own.split(/[.,;!?\n]+/).map((c) => c.trim()).filter(Boolean);
    if (clauses.includes(quote.replace(/[.,;!?]+$/, '').trim())) return true;
  }
  return false;
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

// A nudge on how the work was split, or null. With `advisory` (the hook) a dispatch with no `Track:`
// line is not judged: the line helps the check, it is not owed.
function verdict(lines, input, ctx, { advisory = false } = {}) {
  const own = `${input.command || ''}\n${input.description || ''}`.split('\n').filter((l) => /^\W*Track:/.test(l));
  const tracks = [...own, ...trackLines(lines)];
  if (!tracks.length) {
    if (advisory) return null;
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
        'coordinator merges them into an integration branch and runs the shared tests there (ntv-orca § 2, Song song và cap). ' +
        'Groups that truly edit one shared source file list that file in each group, and stay one track. ' +
        'A shared test, doc, plan or fixture file does not link groups. The worker starts as given; split the next ' +
        'dispatch if the groups are truly independent.';
    }
    const split = unrelatedTasks(line, ctx);
    if (split.length) {
      return `\`${line.trim()}\` bundles tasks that share no source file (${split.join(', ')}): give each its own ` +
        'worker, dispatched now (ntv-orca § 2, Song song và cap); shared test, doc, plan or fixture files do not count. Only the ' +
        'user\'s request for serial work or memory pressure ≥2 keeps them together, written on the line as ' +
        '`(serial: <lý do>)`. The worker starts as given; this is a hint for the next split.' + serialNote;
    }
  }
  return null;
}

module.exports = { unpinnedClaudeModel, readsInbox, newSpecs, rootOf, unrelatedTasks, sprawlingTask, verdict, workerStarts, workerText, prodWrites, prodWriteAllowed, workerSession };
if (require.main !== module) return;

let raw = '';
process.stdin.on('data', (c) => (raw += c));

// Nudges collected so far, said as context when the hook ends, a crash included.
const notes = [];
function say() {
  if (notes.length) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: `dispatch-split-guard: ${notes.join(' Also: ')}` },
    }));
  }
  process.exit(0);
}

process.stdin.on('end', () => {
  try {
    const { transcript_path: transcript, agent_id: agentId, tool_input: input, cwd, session_id: sessionId } = JSON.parse(raw);
    const command = String(input?.command || '');
    if (!transcript || agentId || !toWorker(command)) process.exit(0);
    const writes = prodWrites(workerText(command, cwd));
    let lines = null;
    if (writes.length) { try { lines = tailLines(transcript); } catch (_) { lines = []; } }
    let head = [];
    if (writes.length) { try { head = fs.readFileSync(transcript, 'utf8').slice(0, 1024 * 1024).split('\n'); } catch (_) { head = []; } }
    if (writes.length && !workerSession(head) && !prodWriteAllowed(command, lines)) {
      process.stderr.write(`dispatch-split-guard: this hands a worker a production write (\`${writes[0].slice(0, 160)}\`). ` +
        'A worker only scouts, builds the command and runs it with `--dry-run`, then reports the output; the coordinator ' +
        'runs it for real and reads it back (ntv-implement § Who works). Mark each such line `--dry-run`, or say the ' +
        'worker must not run it. The user asked for this worker to write: add a `# Prod-write: "<their sentence>"` line.\n');
      process.exit(2);
    }
    const starts = workerStarts(command);
    if (newSpecs(command, cwd).some((spec) => spec !== null && !readsInbox(spec))) {
      notes.push('the spec never asks the worker to read its inbox mid-turn, so a correction may land only after its ' +
        'turn (ntv-orca § 2, § 3). If you need to steer it, `send` the line: "chạy `orca orchestration check --peek` ' +
        'trước mỗi commit, trước lệnh dài và sau khoảng mỗi 10 lệnh; có tin mới của coordinator thì làm theo trước".');
    }
    if (!starts.segs.length) say();
    if (onlyHelp(starts.segs)) say();
    const { firstTime, again } = require('./lib/block-once.cjs');
    const model = unpinnedClaudeModel(command, starts);
    if (model && firstTime(sessionId, 'dispatch-split-guard-model', command)) {
      process.stderr.write(`dispatch-split-guard: a claude worker takes a bare alias (\`--model opus\`, sonnet, ` +
        `fable, haiku), not \`${model}\` (ntv-orca § 2, Chọn model): an id outside Orca's catalog drops the worker's ` +
        `\`Approve for me\` mode.${again(sessionId)}\n`);
      process.exit(2);
    }
    if (missingEffort(starts) && firstTime(sessionId, 'dispatch-split-guard-effort', command)) {
      process.stderr.write('dispatch-split-guard: an antigravity worker needs a bare slug plus `--effort`, ' +
        'its `agy models` row minus the `-low|-medium|-high` suffix (ntv-orca § 2, Chọn model); without it agy ' +
        `runs Medium. A model with one level gets exactly that level (\`agy models\`).${again(sessionId)}\n`);
      process.exit(2);
    }
    if (starts.segs.every((seg) => /\s--retry-of\b/.test(seg))) say();
    const once = (f) => { let v; return () => (v === undefined ? (v = f()) : v); };
    const ctx = { serial: once(() => userAskedSerial(tailLines(transcript))), pressure: once(memoryPressure) };
    const problem = verdict(tailLines(transcript), input, ctx, { advisory: true });
    if (problem) notes.push(problem);
    say();
  } catch (_) { /* fail-open: what was collected is still said */ }
  say();
});
