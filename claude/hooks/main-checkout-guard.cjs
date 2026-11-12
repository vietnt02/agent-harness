#!/usr/bin/env node
/**
 * main-checkout-guard.cjs - PreToolUse(Bash): git that writes into the user's main checkout
 * (merge, pull, reset, checkout, switch, commit, …; in cwd, after `cd`, or under `-C`) is blocked
 * once with a reminder: new work goes in its own worktree from `origin/<base>` (CLAUDE.md §
 * Mutation gate), and reading the latest code needs only `git fetch` + `git show origin/<b>:<path>`.
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

const GIT_WRITE = new Set(['merge', 'pull', 'rebase', 'reset', 'checkout', 'switch', 'commit', 'cherry-pick', 'revert', 'am', 'clean', 'restore', 'update-ref']);
const STASH_READ = new Set(['list', 'show', 'create']);
const WORKTREE_WRITE = new Set(['add', 'remove', 'move']);
// Global options that take the next word as their value.
const GLOBAL_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env']);
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
        'Updating the checkout after a merge the user approved is fine.' + again(sessionId) + '\n'
    );
    process.exit(2);
  } catch (_) { /* fail-open */ }
  process.exit(0);
});
