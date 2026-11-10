#!/usr/bin/env node
/**
 * gate-line-guard.cjs - PreToolUse(Bash): a command that changes another machine (ssh running a
 * write/delete/restart, scp or rsync) is blocked until the command (a `# Gate:` comment line or its
 * description) or visible text of the current turn holds `Gate:` (CLAUDE.md § Mutation gate). Edit/Write hooks never see these commands, and
 * the line was skipped there before (2026-10-13, n8n-pg on vps_n8n).
 * A `Gate:` already in an earlier Bash call of the turn counts, so it is written once per turn.
 * Like answer-first.cjs, re-reads the transcript for up to WAIT_MS before blocking, since text
 * written right before the call reaches disk ~0.1 s later. Text written right before a tool call is
 * stored as a paraphrased `narration` thinking block (2026-10-15), so only the call itself is reliable. Subagents are skipped. Fails open.
 * Same gate for git writing into the user's main checkout (merge, pull, reset, checkout, …): a linked
 * worktree passes, since workers and approved work live in their own. Reading the latest code needs
 * only `git fetch` + `git show origin/<b>:<path>`. `git -c core.hooksPath=…` is gated everywhere.
 * A known production write (`cf … update|create|delete…`, `wrangler deploy`, `gh pr merge`, `glab mr
 * merge`) after another step in the same call is blocked whatever the Gate: `a | tail && cf …` runs
 * the write even when `a` failed (a pipe returns its last command's status), so it runs alone.
 * Scope: this catches the slips of an agent that follows its rules, not an agent trying to get past
 * it (that is no security boundary; permissions are). Commands agents really write are read right
 * and never blocked by mistake; shell tricks that hide a git write (brace expansion, escaped
 * flags, deep nesting) are out of scope, since chasing them grows the parser and the false blocks.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { promptText } = require('./lib/user-intent.cjs');
const { expandHome, toSlash } = require('./lib/platform.cjs');
const { commands, program, innerScript, assignments, expandVars } = require('./lib/shell-words.cjs');

const TAIL_BYTES = 512 * 1024;
const WAIT_MS = 1500;
const POLL_MS = 100;

const REMOTE_WRITE = new RegExp(
  [
    String.raw`(?:^|[;&|(\n]\s*|\b(?:then|do)\s+)(?:\w+=\S*\s+)*ssh\s.*(\brm\b|\bmv\b|\bcp\b|\bsed\s+-i|\btee\b|\btruncate\b|\bchmod\b|\bchown\b|\bkill(all)?\b|\bpkill\b`,
    String.raw`|\bdocker(-compose)?\s+(rm|stop|kill|restart|start|run|pull|compose\s+(up|down|rm|stop|restart|pull))`,
    String.raw`|\bsystemctl\s+(start|stop|restart|reload|enable|disable)|\b(insert|update|delete|drop|alter|truncate)\s`,
    String.raw`|[^2&]>(?!\s*/dev/null))`,
    String.raw`|^\s*(scp|rsync)\b|[;&|\n]\s*(scp|rsync)\b`,
  ].join(''),
  'is'
);

const GIT_WRITE = new Set(['merge', 'pull', 'rebase', 'reset', 'checkout', 'switch', 'commit', 'cherry-pick', 'revert', 'am', 'clean', 'restore', 'update-ref']);
const STASH_READ = new Set(['list', 'show', 'create']);
const WORKTREE_WRITE = new Set(['add', 'remove', 'move']);
// Global options that take the next word as their value.
const GLOBAL_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env']);
const HOOKS_OFF = /\bgit\s+(?:\S+\s+)*?-c\s+core\.hookspath=/i;
const unquote = (s) => s.replace(/^(["'])(.*)\1$/, '$2');
const resolveDir = (p, base) => path.resolve(base, expandHome(unquote(p)));

// True for a path inside a Claude Code session scratchpad (`<tmp>/claude-<uid>/<project>/<session>/
// scratchpad`), made or not yet: a repo there is a fixture of the session, never the user's checkout.
const TMP_ROOTS = [...new Set(['/tmp', '/private/tmp', os.tmpdir()].flatMap((r) => {
  try { return [r, fs.realpathSync(r)]; } catch { return [r]; }
}).map(toSlash))];
const inScratchpad = (dir) => {
  const d = toSlash(dir);
  return TMP_ROOTS.some((r) => d.startsWith(`${r}/`) && /^\/claude-\d+\/[^/]+\/[^/]+\/scratchpad(\/|$)/.test(d.slice(r.length)));
};

// True when the directory is a repo's main checkout, not a linked worktree.
function isMainCheckout(dir) {
  try {
    const [gitDir, common] = execFileSync(
      'git', ['-C', dir, 'rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir'],
      { encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'] }
    ).trim().split('\n');
    return Boolean(gitDir) && gitDir === common;
  } catch {
    return false;
  }
}

// Where a git command that writes into a checkout runs: `{ dirs }` (its `-C` paths, applied in
// order), `{ dirs: null }` when a global option or variable points it elsewhere (`--git-dir`,
// `--work-tree`, `GIT_DIR=`), or null when it is no write. `words` are one simple command from
// shell-words, so text inside quotes, comments and heredoc bodies are never read as commands.
function gitWrite(raw, words) {
  if (words[0] !== 'git') return null;
  let dirs = raw.some((w) => /^GIT_(DIR|WORK_TREE|COMMON_DIR)=/.test(w)) ? null : [];
  let i = 1;
  while (i < words.length && words[i].startsWith('-')) {
    const w = words[i];
    if (w === '-C' && dirs) dirs.push(words[i + 1] || '.');
    if (/^--(git-dir|work-tree)(=|$)/.test(w)) dirs = null;
    i += GLOBAL_VALUE.has(w) ? 2 : 1;
  }
  const sub = words[i];
  const args = words.slice(i + 1);
  const write = GIT_WRITE.has(sub) ||
    (sub === 'stash' && !STASH_READ.has(args[0])) ||
    (sub === 'branch' && args.some((a) => /^-[a-zA-Z]*[dDmMfcCu]/.test(a) || /^--(delete|move|force|copy|set-upstream-to|unset-upstream|edit-description)\b/.test(a))) ||
    (sub === 'worktree' && WORKTREE_WRITE.has(args[0])) ||
    (sub === 'tag' && args.some((a) => /^-[a-zA-Z]*[df]/.test(a) || a === '--delete' || a === '--force'));
  return write ? { dirs } : null;
}

// The directory a `cd`/`pushd` leads to from `base`, or null when it cannot be known here (a
// variable the command did not set to a literal, `-`, a stack entry, a directory that does not
// exist yet).
function cdTarget(words, base, vars = {}) {
  if (base === null) return null;
  const args = words.slice(1).filter((a, k, all) => !(/^-[LPe@]+$/.test(a) && all.slice(0, k).every((b) => b.startsWith('-'))));
  const raw = args[0] === '--' ? args[1] : args[0];
  const target = raw && expandVars(raw, vars);
  if (words[0] === 'popd' || !target || target === '-' || /^[+-]\d+$/.test(target)) return null;
  const dir = resolveDir(target, base);
  return fs.existsSync(dir) || inScratchpad(dir) ? dir : null;
}

// True when a git write in the command may target a main checkout. Its directory: the `-C` paths,
// from the one the `cd`s before it lead to in its own shell (a `cd` inside `(…)` or `$(…)` ends
// there), else the hook's cwd; a directory that cannot be known counts as a main checkout. The
// script of `bash -c`/`eval` is read the same way.
function writesMainCheckout(command, cwd) {
  const cds = [];
  const sets = [];
  const inScope = (scope, of) => scope === of || scope.startsWith(`${of}.`);
  const dirIn = (scope) => {
    let dir = cwd;
    for (const cd of cds) if (inScope(scope, cd.scope)) dir = cd.dir;
    return dir;
  };
  // The literal variables a command in `scope` sees; a value that cannot be known unsets its name.
  // Any command other than a plain assignment or a `cd` may rebind a name (`unset`, `read`, `for`,
  // `{ X=…; }`, a function), so it forgets them all for its own shell: a variable is followed only
  // right after it is set. A command inside `$(…)` or `(…)` cannot rebind the outer shell's names.
  const varsIn = (scope) => {
    const vars = {};
    for (const v of sets) {
      if (v.forget) { if (inScope(scope, v.scope)) for (const k of Object.keys(vars)) delete vars[k]; continue; }
      if (inScope(scope, v.scope)) { if (v.value === null) delete vars[v.name]; else vars[v.name] = v.value; }
    }
    return vars;
  };
  const isMain = (dir) => dir === null || (!inScratchpad(dir) && isMainCheckout(dir));
  for (const raw of commands(command)) {
    const words = program(raw);
    const vars = varsIn(raw.scope);
    const set = assignments(raw);
    if (set) {
      for (const [name, value] of set) sets.push({ scope: raw.scope, name, value: expandVars(value, vars) });
      continue;
    }
    let here = dirIn(raw.scope);
    if (words.chdir !== undefined) here = cdTarget(['cd', words.chdir], here, vars);
    if (['cd', 'pushd', 'popd'].includes(words[0])) {
      cds.push({ scope: raw.scope, dir: cdTarget(words, here, vars) });
      continue;
    }
    sets.push({ forget: true, scope: raw.scope });
    const script = innerScript(words);
    if (script !== null && (here === null ? /\bgit\b/.test(script) : writesMainCheckout(script, here))) return true;
    const git = gitWrite(raw, words);
    if (!git) continue;
    const dir = git.dirs && git.dirs.reduce((d, c) => {
      const to = d === null ? null : expandVars(c, vars);
      return to === null ? null : resolveDir(to, d);
    }, here);
    if (isMain(git.dirs ? dir : null)) return true;
  }
  return false;
}

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

// True once, since the user's latest prompt, visible assistant text holds `Gate:` or an earlier
// Bash call holds a `# Gate: mở bởi …` line: the line is printed once per turn, before its first change.
function gatePrinted(lines) {
  // In a call, only an opening line counts: `# Gate: không áp (chỉ đọc)` or a grep for the word opens nothing.
  const holds = (b) => (b.type === 'text' && String(b.text).includes('Gate:')) ||
    (b.type === 'tool_use' && b.name === 'Bash' && /^\s*#\s*Gate:\s*mở bởi/m.test(String(b.input?.command || '')));
  for (let i = lines.length - 1; i >= 0; i--) {
    let rec;
    try { rec = JSON.parse(lines[i]); } catch { continue; }
    if (promptText(rec) !== null) return false;
    const blocks = (rec.type === 'assistant' && rec.message?.content) || [];
    if (Array.isArray(blocks) && blocks.some(holds)) return true;
  }
  return false;
}

module.exports = { resolveDir, inScratchpad, chainedProdWrite, isMainCheckout, writesMainCheckout, gatePrinted };
if (require.main !== module) return;

let raw = '';
process.stdin.on('data', (c) => (raw += c));
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

process.stdin.on('end', () => {
  try {
    const { transcript_path: transcript, agent_id: agentId, tool_input: input, cwd } = JSON.parse(raw);
    const command = String(input?.command || '');
    if (!transcript || agentId) process.exit(0);
    const chained = chainedProdWrite(command);
    if (chained) {
      process.stderr.write(
        `gate-line-guard: \`${chained.slice(0, 120)}\` writes to production after another step in the same call. ` +
          'A failed step before it can still let it run (a pipe returns its last command\'s status). ' +
          'Run the earlier steps, read their output, then run the write alone in its own call.\n'
      );
      process.exit(2);
    }
    const remote = REMOTE_WRITE.test(command);
    const git = !remote && (HOOKS_OFF.test(command) || writesMainCheckout(command, cwd || process.cwd()));
    if (!remote && !git) process.exit(0);
    if (`${command}\n${input?.description || ''}`.includes('Gate:')) process.exit(0);
    let ok = gatePrinted(tailLines(transcript));
    for (let waited = 0; !ok && waited < WAIT_MS; waited += POLL_MS) {
      sleep(POLL_MS);
      ok = gatePrinted(tailLines(transcript));
    }
    if (!ok) {
      process.stderr.write(
        (git
          ? 'gate-line-guard: this command writes into the user\'s main git checkout (or turns git hooks off) and this turn has no `Gate:` line. ' +
            'To read the latest code: `git fetch`, then `git show origin/<b>:<path>` / `git grep … origin/<b>`; never fast-forward their checkout. '
          : 'gate-line-guard: this command changes another machine and this turn has no `Gate:` line. ') +
          'Put `# Gate: mở bởi "<the user\'s sentence>" → khối <X>` as a comment line in the command, then rerun ' +
          '(text written before a call is not kept verbatim). If it only reads, `# Gate: không áp (chỉ đọc)`.\n'
      );
      process.exit(2);
    }
  } catch (_) { /* fail-open */ }
  process.exit(0);
});
