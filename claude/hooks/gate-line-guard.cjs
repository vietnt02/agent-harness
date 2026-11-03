#!/usr/bin/env node
/**
 * gate-line-guard.cjs - PreToolUse(Bash): a command that changes another machine (ssh running a
 * write/delete/restart, scp or rsync) is blocked until the command (a `# Gate:` comment line or its
 * description) or visible text of the current turn holds `Gate:` (CLAUDE.md § Mutation gate). Edit/Write hooks never see these commands, and
 * the line was skipped there before (2026-10-13, n8n-pg on vps_n8n).
 * Like answer-first.cjs, re-reads the transcript for up to WAIT_MS before blocking, since text
 * written right before the call reaches disk ~0.1 s later. Text written right before a tool call is
 * stored as a paraphrased `narration` thinking block (2026-10-15), so only the call itself is reliable. Subagents are skipped. Fails open.
 * Same gate for git writing into the user's main checkout (merge, pull, reset, checkout, …): a linked
 * worktree passes, since workers and approved work live in their own. Reading the latest code needs
 * only `git fetch` + `git show origin/<b>:<path>`. `git -c core.hooksPath=…` is gated everywhere.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { promptText } = require('./lib/user-intent.cjs');
const { expandHome } = require('./lib/platform.cjs');
const { commands, program, innerScript } = require('./lib/shell-words.cjs');

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

// Subcommands that change a checkout, its index, refs or config; the rest by their arguments below.
const GIT_WRITE = new Set(['merge', 'pull', 'rebase', 'reset', 'checkout', 'switch', 'commit', 'cherry-pick', 'revert', 'am',
  'clean', 'restore', 'update-ref', 'rm', 'mv', 'add', 'apply', 'update-index', 'read-tree', 'checkout-index']);
// Subcommands whose first argument says whether they read: the listed values read, any other writes.
const READS_BY_FIRST_ARG = {
  stash: ['list', 'show', 'create'],
  worktree: ['list'],
  submodule: [undefined, 'status', 'summary'],
  bisect: ['log', 'visualize', 'view'],
  'sparse-checkout': ['list'],
  notes: [undefined, 'list', 'show'],
};
const TAG_LIST = /^(-l|--list|-n\d*|--contains|--no-contains|--points-at|--merged|--no-merged|-v|--verify|--column|--sort(=.*)?|--format(=.*)?|-i|--ignore-case)$/;
const CONFIG_WRITE = /^(--unset|--unset-all|--add|--replace-all|--rename-section|--remove-section|-e|--edit)$/;
// Global options that take the next word as their value.
const GLOBAL_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env']);
const GIT_ENV = /^GIT_(DIR|WORK_TREE|COMMON_DIR|INDEX_FILE)=/;
const MAX_SCRIPT_DEPTH = 8;
const HOOKS_OFF = /\bgit\s+(?:\S+\s+)*?-c\s+core\.hookspath=/i;
const unquote = (s) => s.replace(/^(["'])(.*)\1$/, '$2');
const resolveDir = (p, base) => path.resolve(base, expandHome(unquote(p)));

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

// True when `git <sub> <args…>` changes a checkout, its index, refs or config.
function gitWrites(sub, args) {
  if (GIT_WRITE.has(sub)) return true;
  if (Object.hasOwn(READS_BY_FIRST_ARG, sub)) return !READS_BY_FIRST_ARG[sub].includes(args[0]);
  if (sub === 'branch') {
    return args.some((a) => /^-[a-zA-Z]*[dDmMfcCu]/.test(a) || /^--(delete|move|force|copy|set-upstream-to|unset-upstream|edit-description)\b/.test(a));
  }
  if (sub === 'tag') {
    if (args.some((a) => /^-[a-zA-Z]*[df]/.test(a) || a === '--delete' || a === '--force')) return true;
    return args.some((a) => !a.startsWith('-')) && !args.some((a) => TAG_LIST.test(a));
  }
  if (sub === 'config') {
    if (['set', 'unset', 'rename-section', 'remove-section', 'edit'].includes(args[0])) return true;
    if (['get', 'list'].includes(args[0]) || args.some((a) => /^--get/.test(a) || a === '-l' || a === '--list')) return false;
    return args.some((a) => CONFIG_WRITE.test(a)) || args.filter((a) => !a.startsWith('-')).length >= 2;
  }
  return false;
}

// Where a git command that writes runs: `{ dirs }` (its `-C` paths, applied in order), `{ dirs:
// null }` when a global option or variable points it elsewhere (`--git-dir`, `--work-tree`,
// `GIT_DIR=`), or null when it is no write. `words` are one simple command from shell-words, so
// text inside quotes, comments and heredoc bodies are never read as commands.
function gitWrite(words, envUnknown) {
  if (words[0] !== 'git') return null;
  let dirs = envUnknown ? null : [];
  let i = 1;
  while (i < words.length && words[i].startsWith('-')) {
    const w = words[i];
    if (w === '-C' && dirs) dirs.push(words[i + 1] || '.');
    if (/^--(git-dir|work-tree)(=|$)/.test(w)) dirs = null;
    i += GLOBAL_VALUE.has(w) ? 2 : 1;
  }
  return gitWrites(words[i], words.slice(i + 1)) ? { dirs } : null;
}

// The directory `p` names from `base`, or null when it cannot be known here: a variable, a
// substitution, a brace or glob, or no such directory (yet).
function knownDir(p, base) {
  if (base === null || p === undefined || /[$`{}*?]/.test(p)) return null;
  const dir = resolveDir(p, base);
  try { return fs.statSync(dir).isDirectory() ? dir : null; } catch { return null; }
}

// The directory a `cd`/`pushd`/`popd` leads to from `base`, or null when it cannot be known.
function cdTarget(words, base) {
  if (words[0] === 'popd') return null;
  let k = 1;
  while (/^-[LPe@]+$/.test(words[k] || '')) k++;
  if (words[k] === '--') k++;
  const target = words[k];
  if (target === undefined) return words[0] === 'cd' ? knownDir(os.homedir(), '/') : null;
  if (target === '-' || /^[+-]\d+$/.test(target)) return null;
  return knownDir(target, base);
}

// True when a git write in the command may target a main checkout. Its directory: the `-C` paths,
// from the one the `cd`s before it lead to in its own shell (a `cd` inside `(…)`, `$(…)`, a
// pipeline element or a background job ends there; one inside `if`/`while`/`case` may not run, so
// it makes the directory unknown), else the hook's cwd. A directory that cannot be known counts as
// a main checkout, and so does any `git` in a command the parser could not read whole. Scripts of
// `bash -c`, `bash <<<` and `eval` are read the same way; `eval` runs in this shell, so its `cd`
// carries on. A shell reading a script from a pipe is unknown.
function writesMainCheckout(command, cwd) {
  const state = { entries: [], next: 0 };
  return walk(String(command || ''), (s) => s, cwd, state, 0);
}

function walk(command, scopeOf, cwd, state, level) {
  const list = commands(command);
  const mentionsGit = /git/.test(command);
  if (list.incomplete || level > MAX_SCRIPT_DEPTH) return mentionsGit;
  const applies = (entry, scope) => scope === entry.scope || scope.startsWith(`${entry.scope}.`);
  const dirIn = (scope) => {
    let dir = cwd;
    for (const e of state.entries) if ('dir' in e && applies(e, scope)) dir = e.dir;
    return dir;
  };
  const envIn = (scope) => state.entries.some((e) => e.env && applies(e, scope));
  let cond = 0;
  for (const raw of list) {
    const scope = scopeOf(raw.scope);
    if (/^(if|while|until|case)$/.test(raw[0])) cond++;
    if (/^(fi|done|esac)$/.test(raw[0])) cond = Math.max(0, cond - 1);
    if (raw.braces && raw.some((w) => /git/.test(w))) return true;
    const words = program(raw);
    const pre = raw.slice(0, Math.max(0, raw.length - words.length));
    if (!words.length || /^(export|declare|typeset|readonly|local)$/.test(words[0])) {
      if ([...pre, ...words].some((w) => GIT_ENV.test(w))) state.entries.push({ scope, env: true });
      continue;
    }
    let here = dirIn(scope);
    if (words.chdir !== undefined) here = knownDir(words.chdir, here);
    if (['cd', 'pushd', 'popd'].includes(words[0])) {
      state.entries.push({ scope, dir: cond > 0 ? null : cdTarget(words, here) });
      continue;
    }
    const inner = innerScript(words);
    if (inner) {
      if (inner.script === null) {
        if (mentionsGit) return true;
        continue;
      }
      const id = ++state.next;
      const child = inner.same ? (s) => (s === '0' ? scope : `${scope}.e${id}${s.slice(1)}`) : (s) => `${scope}.c${id}${s.slice(1)}`;
      if (!inner.same) state.entries.push({ scope: child('0'), dir: here });
      if (walk(inner.script, child, cwd, state, level + 1)) return true;
      continue;
    }
    const git = gitWrite(words, envIn(scope) || pre.some((w) => GIT_ENV.test(w)));
    if (!git) continue;
    const dir = git.dirs && git.dirs.reduce((d, c) => knownDir(c, d), here);
    if (!git.dirs || dir === null || isMainCheckout(dir)) return true;
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

// True once visible assistant text since the user's latest prompt holds `Gate:`.
function gatePrinted(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    let rec;
    try { rec = JSON.parse(lines[i]); } catch { continue; }
    if (promptText(rec) !== null) return false;
    const blocks = (rec.type === 'assistant' && rec.message?.content) || [];
    if (blocks.some((b) => b.type === 'text' && b.text.includes('Gate:'))) return true;
  }
  return false;
}

module.exports = { resolveDir, isMainCheckout, writesMainCheckout, gatePrinted };
if (require.main !== module) return;

let raw = '';
process.stdin.on('data', (c) => (raw += c));
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

process.stdin.on('end', () => {
  try {
    const { transcript_path: transcript, agent_id: agentId, tool_input: input, cwd } = JSON.parse(raw);
    const command = String(input?.command || '');
    if (!transcript || agentId) process.exit(0);
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
