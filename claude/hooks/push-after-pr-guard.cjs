#!/usr/bin/env node
/**
 * push-after-pr-guard.cjs - PreToolUse(Bash): block `git push` to a branch whose PR/MR
 * is already merged or closed, so follow-ups go to a new branch (CLAUDE.md § Irreversible
 * actions, push after a PR). The PR/MR state is read with every logged-in `gh` account (or each glab
 * config dir) in turn, since the shell's active account may not see a private repo; a remote whose
 * host is not github.com is treated as GitLab. When the state still cannot be read, the push is let
 * through and the reason goes back to Claude as context (a silent pass hid that the check was off).
 * Limit: a push run by a script or another tool (`glab mr create --push`) is not seen.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { expandHome } = require('./lib/platform.cjs');
const { commands, program, assignments, expandVars } = require('./lib/shell-words.cjs');

// One deadline for the whole hook, under the 15 s an agy bridge allows, so a hung gh still ends
// in a voiced pass instead of a kill.
const DEADLINE = Date.now() + 12000;
const left = () => {
  const ms = Math.min(8000, DEADLINE - Date.now());
  if (ms < 300) throw Object.assign(new Error('hết giờ kiểm (12 s)'), { code: 'ETIMEDOUT' });
  return ms;
};
const runEnv = (cmd, args, cwd, env = {}) =>
  execFileSync(cmd, args, { cwd, env: { ...process.env, ...env }, encoding: 'utf8', timeout: left(), stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const run = (cmd, args, cwd) => runEnv(cmd, args, cwd);
// Credentials in a URL (`https://user:token@host`) never reach the context.
const redact = (t) => String(t).replace(/\/\/[^/@\s]+@/g, '//***@');
// The reason an error gives: the last stderr line of the failed command, else its message.
const why = (e) => redact(String((e && e.stderr) || '').trim().split('\n').pop() ||
  String((e && e.message) || e).split('\n')[0]).slice(0, 160);

const unquote = (t) => t.replace(/"([^"]*)"|'([^']*)'/g, (_, a, b) => a ?? b);
// push flags whose value is the next word (not a remote or refspec).
const PUSH_VALUE = new Set(['-o', '--push-option', '--repo', '--receive-pack', '--exec']);
// A shell redirection (`2>&1`, `> log`) is not an argument; a bare `>` takes the next word.
const REDIRECT = /^\d*(?:[<>]|&>)/;
const expand = (dir, cwd) => path.resolve(cwd, expandHome(unquote(dir)));

// Each `git push` in the command, with the directory it runs in (null when a variable the command
// did not set to a literal hides it). Commands come from shell-words, so text in quotes, comments
// and heredoc bodies (a commit message, a PR body, a script) is never read as a push.
function findPushes(command, startCwd) {
  const pushes = [];
  const log = [];
  const inScope = (scope, of) => scope === of || scope.startsWith(`${of}.`);
  // The directory and literal variables a command in `scope` sees. Any command other than a plain
  // assignment or a `cd` may rebind a name (`unset`, `read`, `for`…), so it forgets them all for
  // its own shell: a variable is followed only right after it is set.
  const seen = (scope) => {
    let cwd = startCwd;
    const vars = {};
    for (const e of log) {
      if (!inScope(scope, e.scope)) continue;
      if ('cd' in e) cwd = e.cd;
      else if (e.forget) for (const k of Object.keys(vars)) delete vars[k];
      else if (e.value === null) delete vars[e.name];
      else vars[e.name] = e.value;
    }
    return { cwd, vars };
  };
  const to = (dir, base, vars) => {
    const literal = base === null ? null : expandVars(dir, vars);
    return literal === null ? null : expand(literal, base);
  };
  for (const raw of commands(command)) {
    const { cwd, vars } = seen(raw.scope);
    const set = assignments(raw);
    if (set) {
      for (const [name, value] of set) log.push({ scope: raw.scope, name, value: expandVars(value, vars) });
      continue;
    }
    const toks = program(raw);
    if (toks[0] === 'cd' && toks[1]) { log.push({ scope: raw.scope, cd: to(toks[1], cwd, vars) }); continue; }
    log.push({ scope: raw.scope, forget: true });
    if (toks[0] !== 'git') continue;
    let i = 1;
    let dir = cwd;
    while (i < toks.length && toks[i].startsWith('-')) {
      if (toks[i] === '-C') { dir = to(toks[i + 1] || '.', cwd, vars); i += 2; }
      else if (toks[i] === '-c') i += 2;
      else i += 1;
    }
    if (toks[i] !== 'push') continue;
    const args = toks.slice(i + 1);
    if (args.some((a) => ['-d', '--delete', '--tags'].includes(a))) continue;
    const positional = args.filter((a, k) => !a.startsWith('-') && !PUSH_VALUE.has(args[k - 1]) &&
      !REDIRECT.test(a) && !/^\d*(?:[<>]{1,2}|&>)$/.test(args[k - 1] || ''));
    const repo = args.reduce((r, a, k) => (a === '--repo' ? args[k + 1] : a.startsWith('--repo=') ? a.slice(7) : r), null);
    const refspecs = positional.slice(1);
    // `:branch` deletes it, like --delete.
    if (refspecs.length && refspecs.every((r) => r.startsWith(':'))) continue;
    pushes.push({ dir, remote: positional[0] || repo || 'origin', refspecs: refspecs.filter((r) => !r.startsWith(':')) });
  }
  return pushes;
}

function branchesOf({ dir, refspecs }) {
  const current = () => run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], dir);
  if (refspecs.length === 0) return [current()];
  return refspecs.map((r) => {
    const dst = r.replace(/^\+/, '').split(':').pop().replace(/^refs\/heads\//, '');
    return dst === 'HEAD' ? current() : dst;
  });
}

// Runs `fn` as the shell's identity, then with each identity `more()` lists (asked only after a
// failure), until one succeeds; throws the first error. A timeout is the network, not the identity:
// it stops at once.
function firstThatWorks(more, fn) {
  let first;
  try { return fn({}); } catch (e) { first = e; }
  if (first.code === 'ETIMEDOUT') throw first;
  for (const env of more()) {
    try { return fn(env); } catch (e) { if (e.code === 'ETIMEDOUT') throw first; }
  }
  throw first;
}

const once = (f) => { let v; return () => (v ??= f()); };

// gh: each logged-in account other than the active one, by its token.
const ghEnvs = once(() => {
  const envs = [];
  let status = '';
  let active = '';
  try { status = runEnv('gh', ['auth', 'status']); } catch (e) { status = `${e.stdout || ''}${e.stderr || ''}`; }
  try { active = run('gh', ['auth', 'token']); } catch (_) { /* none */ }
  for (const m of status.matchAll(/account\s+(\S+)/g)) {
    let token = '';
    try { token = run('gh', ['auth', 'token', '--user', m[1]]); } catch (_) { /* skip */ }
    if (token && token !== active && !envs.some((e) => e.GH_TOKEN === token)) envs.push({ GH_TOKEN: token });
  }
  return envs;
});

// glab: each ~/.config/glab-* config dir.
function glabDirs(home = os.homedir()) {
  const dir = path.join(home, '.config');
  let extra = [];
  try { extra = fs.readdirSync(dir).filter((d) => /^glab-/.test(d)).map((d) => ({ GLAB_CONFIG_DIR: path.join(dir, d) })); } catch (_) { /* none */ }
  return extra;
}
const glabEnvs = once(() => glabDirs());

// Returns [{ id, state }] with state normalised to OPEN / MERGED / CLOSED.
function reviewsFor(dir, remote, branch, { gh = ghEnvs, glab = glabEnvs } = {}) {
  if (!fs.existsSync(dir)) throw new Error(`thư mục ${dir} không tồn tại`);
  const url = run('git', ['remote', 'get-url', remote], dir);
  if (!/github\.com[:/]/.test(url)) {
    const mrs = firstThatWorks(glab, (env) => JSON.parse(runEnv('glab', ['mr', 'list', '--source-branch', branch, '--all', '-F', 'json'], dir, env)));
    return mrs.map((m) => ({ id: `!${m.iid}`, state: { opened: 'OPEN' }[m.state] || m.state.toUpperCase() }));
  }
  const prs = firstThatWorks(gh, (env) => JSON.parse(runEnv('gh', ['pr', 'list', '--head', branch, '--state', 'all', '--json', 'number,state'], dir, env)));
  return prs.map((p) => ({ id: `#${p.number}`, state: p.state }));
}

// What the hook does with a command: { block } naming a branch whose PR/MR is merged or closed,
// else { blind } listing the branches whose state could not be read.
function decide(command, cwd, { reviews = reviewsFor, branches = branchesOf } = {}) {
  const blind = [];
  for (const push of findPushes(command, cwd)) {
    if (push.dir === null) {
      blind.push('không xác định được thư mục của `git push` (nằm sau một biến lệnh không gán giá trị literal)');
      continue;
    }
    let names = [];
    try { names = branches(push); } catch (e) { blind.push(`nhánh ở ${push.dir}: ${why(e)}`); }
    for (const branch of names) {
      if (!branch || branch === 'HEAD') continue;
      let found;
      try { found = reviews(push.dir, push.remote, branch); } catch (e) { blind.push(`"${branch}" (${redact(push.remote)}): ${why(e)}`); continue; }
      if (found.length === 0 || found.some((r) => r.state === 'OPEN')) continue;
      return { block: `push-after-pr-guard: branch "${branch}" already had ${found.map((r) => `${r.id} ${r.state}`).join(', ')}. ` +
        "Push the follow-up to a new branch from the target's current tip and open a new PR/MR.\n" };
    }
  }
  return { blind };
}

module.exports = { findPushes, expand, branchesOf, reviewsFor, firstThatWorks, glabDirs, decide, redact };
if (require.main !== module) return;

let raw = '';
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', () => {
  try {
    const { tool_name: tool, tool_input: input = {}, cwd } = JSON.parse(raw);
    if (tool !== 'Bash' || !/\bgit\b[^\n]*\bpush\b/.test(input.command || '')) process.exit(0);
    const { block, blind } = decide(input.command, cwd || process.cwd());
    if (block) { process.stderr.write(block); process.exit(2); }
    if (blind.length) {
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext:
        `push-after-pr-guard: không đọc được PR/MR của ${blind.join('; ')}. Push vẫn chạy; nhánh từng có PR đã merge ` +
        'hay đóng thì push sau phải sang nhánh mới, nên tự đọc trạng thái (`gh pr list --head <nhánh> --state all` với ' +
        'đúng account, hoặc `glab mr list --source-branch <nhánh> --all`) trước khi báo xong.' } }), () => process.exit(0));
      return;
    }
  } catch (_) { /* fail-open: the command itself could not be parsed */ }
  process.exit(0);
});
