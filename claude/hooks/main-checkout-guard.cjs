#!/usr/bin/env node
/**
 * main-checkout-guard.cjs - PreToolUse(Bash): git that writes into the user's main checkout
 * (merge, reset, checkout, switch, commit, …; in cwd, after `cd`, or under `-C`) is blocked
 * once with a reminder: new work goes in its own worktree from `origin/<base>` (CLAUDE.md §
 * Mutation gate), and reading the latest code needs only `git fetch` + `git show origin/<b>:<path>`.
 * Upkeep that starts no work there passes: `pull` of the branch's own upstream, `worktree
 * add/move/remove/prune`, `branch -d`, `branch -D` of a branch whose tip a remote-tracking ref holds,
 * `worktree add -B` of a branch that is new or already inside its start point. Forms that merge,
 * reset or drop work stay gated: `pull` with a refspec, `--squash`, `--no-commit`, `--no-ff` or
 * `--force`; `-f`/`--force`; any other `-B`, `-D`; removing a detached worktree whose commits no ref
 * holds. A `cd` into the path an earlier `worktree add` of the same command makes is a linked worktree.
 * A `for X in <literal words>` loop gives X each of its words in turn: a git write under `$X` is judged
 * once per word.
 * The same command run again passes (lib/block-once.cjs). A linked worktree and a repo in the
 * session scratchpad pass. `git -c core.hooksPath=…` turns the repo's checks off and is always
 * blocked (CLAUDE.md § Irreversible actions: never bypass a check). Subagents are skipped.
 * Scope: the slips of an agent that follows its rules, on the commands agents really write; shell
 * tricks that hide a git write are out of scope. Fails open.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { expandHome, toSlash } = require('./lib/platform.cjs');
const { commands, program, innerScript, assignments, expandVars } = require('./lib/shell-words.cjs');

const GIT_WRITE = new Set(['merge', 'rebase', 'reset', 'checkout', 'switch', 'commit', 'cherry-pick', 'revert', 'am', 'clean', 'restore', 'update-ref']);
const STASH_READ = new Set(['list', 'show', 'create']);
// `worktree add -B` resets an existing branch; `--force`/`-f` drops a dirty worktree or a lock. A short
// cluster may carry them anywhere but after `-b` (whose value follows: `-bfix/x`); git takes `--fo…`.
const WORKTREE_FORCED = /^(-[ac-zAC-Z]*[fB]|--fo)/;
const WORKTREE_FORCE = /^(-[ac-zAC-Z]*f|--fo)/;
// `worktree add` options whose value is the next word.
const ADD_VALUE = new Set(['-b', '--reason']);
// `pull` that does more than bring the branch up to its upstream: a merge of another branch, a
// staged or forced result.
const PULL_MORE = /^(--(squash|no-commit|no-ff|fo)|-(?![Xsjo])[a-zA-Z]*f[a-zA-Z]*$)/;
// `pull` options whose value is the next word (`--depth 1`, `-X theirs`), never an operand.
const PULL_VALUE = new Set(['-s', '-X', '-j', '-o', '--strategy', '--strategy-option', '--jobs', '--depth', '--deepen',
  '--shallow-since', '--shallow-exclude', '--upload-pack', '--server-option', '--negotiation-tip', '--recurse-submodules']);
// Global options that take the next word as their value.
const GLOBAL_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env']);
// Builtins that can set or unset a shell variable (`printf` only with `-v`). A command with no
// program is shell syntax: a bare keyword (`then`, `do`, `}`) rebinds nothing, but one holding an
// assignment (`{ X=…; }`, a function body) does. Any other command (`rm`, `git`, `head`) runs in
// its own process and leaves the shell's variables as they were.
const REBINDS = new Set(['unset', 'read', 'readarray', 'mapfile', 'export', 'declare', 'local', 'typeset',
  'readonly', 'source', '.', 'eval', 'getopts', 'let']);
const rebinds = (raw, words) => words.length === 0
  ? raw.some((w) => /^[A-Za-z_]\w*\+?=/.test(w))
  : REBINDS.has(words[0]) || (words[0] === 'printf' && words[1] === '-v');
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
  const operands = args.filter((a, k) => !a.startsWith('-') && !(sub === 'pull' && PULL_VALUE.has(args[k - 1])));
  // `worktree add`: the path it makes, and the branch a `-B` resets with its start point.
  if (sub === 'worktree' && args[0] === 'add' && !args.some((a) => WORKTREE_FORCE.test(a))) {
    let resets = null;
    const ops = [];
    for (let k = 1; k < args.length; k++) {
      const a = args[k];
      const b = /^-[ac-zAC-Z]*B(.*)$/.exec(a);
      if (b) { resets = b[1] || args[++k] || ''; continue; }
      if (ADD_VALUE.has(a) || /^-[ac-zAC-Z]*b$/.test(a)) { k++; continue; }
      if (!a.startsWith('-')) ops.push(a);
    }
    return { dirs, adds: ops[0] || null, resets, start: ops[1] || 'HEAD' };
  }
  // `branch -D <b>…`: upkeep when a remote-tracking ref holds each tip (read where it runs).
  if (sub === 'branch' && args.includes('-D') && args.every((a) => !a.startsWith('-') || ['-D', '-q', '--quiet'].includes(a))) {
    return { dirs, deletes: operands };
  }
  if (sub === 'worktree' && args[0] === 'remove' && !args.some((a) => WORKTREE_FORCED.test(a))) {
    return operands[1] ? { dirs, removes: operands[1] } : null;
  }
  // `git pull <remote> <branch>`: upkeep when that is the branch's own upstream (read where it runs).
  if (sub === 'pull' && operands.length === 2 && !operands.some((a) => /[:+]/.test(a)) && !args.some((a) => PULL_MORE.test(a))) {
    return { dirs, pulls: `${operands[0]}/${operands[1]}` };
  }
  const write = GIT_WRITE.has(sub) ||
    (sub === 'pull' && (operands.length > 1 || operands.some((a) => /[:+]/.test(a)) || args.some((a) => PULL_MORE.test(a)))) ||
    (sub === 'stash' && !STASH_READ.has(args[0])) ||
    // `branch -d` deletes only a merged branch: upkeep. `-D`, `-f`, a move or copy can lose work.
    (sub === 'branch' && args.some((a) => /^-[a-zA-Z]*[DmMfcCu]/.test(a) || /^--(move|force|copy|set-upstream-to|unset-upstream|edit-description)\b/.test(a))) ||
    (sub === 'worktree' && args.some((a) => WORKTREE_FORCED.test(a))) ||
    (sub === 'tag' && args.some((a) => /^-[a-zA-Z]*[df]/.test(a) || a === '--delete' || a === '--force'));
  return write ? { dirs } : null;
}

// The directory a `cd`/`pushd` leads to from `base`, or null when it cannot be known here (a
// variable the command did not set to a literal, `-`, a stack entry, a directory that does not
// exist yet).
function cdTarget(words, base, vars = {}, made = new Set()) {
  if (base === null) return null;
  const args = words.slice(1).filter((a, k, all) => !(/^-[LPe@]+$/.test(a) && all.slice(0, k).every((b) => b.startsWith('-'))));
  const raw = args[0] === '--' ? args[1] : args[0];
  const target = raw && expandVars(raw, vars);
  if (words[0] === 'popd' || !target || target === '-' || /^[+-]\d+$/.test(target)) return null;
  const dir = resolveDir(target, base);
  return fs.existsSync(dir) || inScratchpad(dir) || made.has(dir) ? dir : null;
}

// True when a git write in the command may target a main checkout. Its directory: the `-C` paths,
// from the one the `cd`s before it lead to in its own shell (a `cd` inside `(…)` or `$(…)` ends
// there), else the hook's cwd; a directory that cannot be known counts as a main checkout. The
// script of `bash -c`/`eval` is read the same way.
function writesMainCheckout(command, cwd) {
  const cds = [];
  const sets = [];
  const made = new Set(); // paths a `worktree add` earlier in the command makes
  const inScope = (scope, of) => scope === of || scope.startsWith(`${of}.`);
  const dirIn = (scope) => {
    let dir = cwd;
    for (const cd of cds) if (inScope(scope, cd.scope)) dir = cd.dir;
    return dir;
  };
  // The literal variables a command in `scope` sees; a value that cannot be known unsets its name.
  // A command that can rebind a name (`rebinds`: `unset`, `read`, `for`, `{ X=…; }`, a function)
  // forgets them all for its own shell. A command inside `$(…)` or `(…)` cannot rebind the outer
  // shell's names.
  const varsIn = (scope) => {
    const vars = {};
    for (const v of sets) {
      if (v.forget) { if (inScope(scope, v.scope)) for (const k of Object.keys(vars)) delete vars[k]; continue; }
      if (inScope(scope, v.scope)) { if (v.value === null) delete vars[v.name]; else vars[v.name] = v.value; }
      if (inScope(scope, v.scope) && v.values) vars[v.name] = v.values;
    }
    return vars;
  };
  const mains = new Map();
  const isMain = (dir) => {
    if (dir === null) return true;
    if (!mains.has(dir)) mains.set(dir, !inScratchpad(dir) && isMainCheckout(dir));
    return mains.get(dir);
  };
  // One variable map per word of each `for` loop seen (`vars[X]` an array): [vars] when none.
  const variants = (vars) => {
    const k = Object.keys(vars).find((n) => Array.isArray(vars[n]));
    return k ? vars[k].flatMap((v) => variants({ ...vars, [k]: v })) : [vars];
  };
  const scalars = (vars) => Object.fromEntries(Object.entries(vars).filter(([, v]) => !Array.isArray(v)));
  for (const raw of commands(command)) {
    const words = program(raw);
    const loopVars = varsIn(raw.scope);
    const vars = scalars(loopVars);
    const set = assignments(raw);
    if (set) {
      for (const [name, value] of set) sets.push({ scope: raw.scope, name, value: expandVars(value, vars) });
      continue;
    }
    let here = dirIn(raw.scope);
    if (words.chdir !== undefined) here = cdTarget(['cd', words.chdir], here, vars, made);
    if (['cd', 'pushd', 'popd'].includes(words[0])) {
      cds.push({ scope: raw.scope, dir: cdTarget(words, here, vars, made) });
      continue;
    }
    // `for X in …` and `select X in …` rebind only X.
    if (['for', 'select'].includes(words[0]) && /^[A-Za-z_]\w*$/.test(words[1] || '')) {
      const values = words[0] === 'for' && words[2] === 'in' && words.length > 3 ? words.slice(3).map((w) => expandVars(w, vars)) : [];
      const literal = values.length && values.every((v) => v !== null && !/[*?[]/.test(v));
      sets.push({ scope: raw.scope, name: words[1], value: null, values: literal ? values : undefined });
    }
    else if (rebinds(raw, words)) sets.push({ forget: true, scope: raw.scope });
    const script = innerScript(words);
    if (script !== null && (here === null ? /\bgit\b/.test(script) : writesMainCheckout(script, here))) return true;
    const git = gitWrite(raw, words);
    if (!git) continue;
    // Only the loop variables this git command names vary; any other loop is no concern of it.
    const named = new Set([...raw.join(' ').matchAll(/\$\{?(\w+)/g)].map((m) => m[1]));
    const own = Object.fromEntries(Object.entries(loopVars).filter(([k, v]) => !Array.isArray(v) || named.has(k)));
    const looped = Object.values(own).some(Array.isArray);
    if (variants(own).some((each) => gitWrites(git, here, each, looped))) return true;
  }
  return false;

  // True when the git write `git`, run from `here` with `vars`, may target a main checkout. Under a loop
  // word, a directory that does not exist is unknown.
  function gitWrites(git, here, vars, looped) {
    const dir = git.dirs && git.dirs.reduce((d, c) => {
      const to = d === null ? null : expandVars(c, vars);
      const next = to === null ? null : resolveDir(to, d);
      return next !== null && looped && !fs.existsSync(next) && !inScratchpad(next) && !made.has(next) ? null : next;
    }, here);
    if (git.adds !== undefined) {
      const to = dir !== null && git.adds && expandVars(git.adds, vars);
      if (to) made.add(resolveDir(to, dir));
      if (git.resets !== null && isMain(dir) && resetDrops(dir, expandVars(git.resets, vars), expandVars(git.start, vars))) return true;
      return false;
    }
    if (git.deletes) {
      if (isMain(dir) && git.deletes.some((b) => !onRemote(dir, expandVars(b, vars)))) return true;
      return false;
    }
    if (git.removes) {
      if (dir !== null && isMain(dir) && dropsCommits(worktreeAt(dir, expandVars(git.removes, vars) || git.removes))) return true;
      return false;
    }
    if (git.pulls) {
      if (isMain(git.dirs ? dir : null) && (dir === null || upstreamOf(dir) !== git.pulls)) return true;
      return false;
    }
    return isMain(git.dirs ? dir : null);
  }
}

// True when removing the worktree at `dir` loses commits: its HEAD is detached and no ref (branch, tag,
// remote-tracking) holds it, so they go with the worktree's own reflog. Unknown (no such worktree): false.
function dropsCommits(dir) {
  if (!dir) return false;
  const git = (args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 });
  try { git(['symbolic-ref', '-q', 'HEAD']); return false; } catch (_) { /* detached, or no repo */ }
  try { return git(['for-each-ref', '--contains', 'HEAD', '--count=1', '--format=%(refname)']).trim() === ''; } catch (_) { return false; }
}

// True when `worktree add -B <b> … <start>` in `dir` resets a local branch `b` that holds commits
// `start` lacks. A branch that does not exist yet loses nothing; unknown: true.
function resetDrops(dir, b, start) {
  if (!dir || !b || !start) return true;
  const git = (args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 });
  try { git(['rev-parse', '-q', '--verify', `refs/heads/${b}`]); } catch (_) { return false; }
  try { git(['merge-base', '--is-ancestor', `refs/heads/${b}`, start]); return false; } catch (_) { return true; }
}

// True when the tip of the local branch `b` in `dir` is on a remote-tracking ref (pushed), so
// `branch -D` loses nothing. No such branch, or unknown: false.
function onRemote(dir, b) {
  if (!dir || !b) return false;
  const git = (args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 });
  let tip;
  try { tip = git(['rev-parse', '-q', '--verify', `refs/heads/${b}`]).trim(); } catch (_) { return false; }
  try { return git(['for-each-ref', '--contains', tip, '--count=1', '--format=%(refname)', 'refs/remotes']).trim() !== ''; } catch (_) { return false; }
}

// The worktree `git -C <base> worktree remove <operand>` removes: the path, else the one worktree whose
// path ends in `/<operand>` (git takes a unique ending: `remove lone` for `../ws/lone`). None: null.
function worktreeAt(base, operand) {
  const resolved = resolveDir(operand, base);
  if (fs.existsSync(resolved)) return resolved;
  const tail = `/${toSlash(operand).replace(/^\.\//, '').replace(/\/+$/, '')}`;
  try {
    const list = execFileSync('git', ['-C', base, 'worktree', 'list', '--porcelain'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 });
    const hits = list.split('\n').filter((l) => l.startsWith('worktree ')).map((l) => l.slice(9)).filter((p) => toSlash(p).endsWith(tail));
    return hits.length === 1 ? hits[0] : null;
  } catch (_) { return null; }
}

// The upstream (`origin/main`) of the branch checked out at `dir`, or null.
function upstreamOf(dir) {
  try {
    return execFileSync('git', ['-C', dir, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).trim();
  } catch (_) { return null; }
}

// True when a git that runs takes `-c core.hooksPath=…` (a commit message naming it is text).
function hooksOff(command) {
  return commands(command).map(program).some((w) => {
    const script = innerScript(w);
    if (script !== null) return hooksOff(script);
    return w[0] === 'git' && w.some((a, k) => /^core\.hookspath=/i.test(a) && w[k - 1] === '-c');
  });
}

module.exports = { resolveDir, inScratchpad, isMainCheckout, writesMainCheckout, hooksOff };
if (require.main !== module) return;

let raw = '';
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', () => {
  try {
    const { agent_id: agentId, tool_input: input, cwd, session_id: sessionId } = JSON.parse(raw);
    const command = String(input?.command || '');
    if (agentId) process.exit(0);
    if (hooksOff(command)) {
      process.stderr.write('main-checkout-guard: `git -c core.hooksPath=…` turns the repo\'s checks off; ' +
        'run the git command without it (CLAUDE.md § Irreversible actions: never bypass a check).\n');
      process.exit(2);
    }
    if (!writesMainCheckout(command, cwd || process.cwd())) process.exit(0);
    const { firstTime, again } = require('./lib/block-once.cjs');
    if (!firstTime(sessionId, 'main-checkout-guard', command)) process.exit(0);
    process.stderr.write(
      'main-checkout-guard: this git command writes into the user\'s main checkout. New work goes in its own ' +
        'worktree from `origin/<base>`; to read the latest code: `git fetch`, then `git show origin/<b>:<path>`. ' +
        'Upkeep passes unforced: `git pull` of the upstream, `git worktree add/move/remove/prune`, `git branch -d`, ' +
        '`git branch -D` of a pushed branch, `git worktree add -B` of a branch with nothing beyond its start point.' + again(sessionId) + '\n'
    );
    process.exit(2);
  } catch (_) { /* fail-open */ }
  process.exit(0);
});
