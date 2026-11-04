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

const run = (cmd, args, cwd) =>
  execFileSync(cmd, args, { cwd, encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();

const unquote = (t) => t.replace(/"([^"]*)"|'([^']*)'/g, (_, a, b) => a ?? b);
// push flags whose value is the next word (not a remote or refspec).
const PUSH_VALUE = new Set(['-o', '--push-option', '--repo', '--receive-pack', '--exec']);
const expand = (dir, cwd) => path.resolve(cwd, expandHome(unquote(dir)));

// Each `git push` in the command, with the directory it runs in.
function findPushes(command, startCwd) {
  const pushes = [];
  let cwd = startCwd;
  for (const seg of command.split(/&&|\|\||;|\n|\|/)) {
    const toks = (seg.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || []).map(unquote);
    if (toks[0] === 'cd' && toks[1]) { cwd = expand(toks[1], cwd); continue; }
    const g = toks.indexOf('git');
    if (g === -1) continue;
    let i = g + 1;
    let dir = cwd;
    while (i < toks.length && toks[i].startsWith('-')) {
      if (toks[i] === '-C') { dir = expand(toks[i + 1] || '.', cwd); i += 2; }
      else if (toks[i] === '-c') i += 2;
      else i += 1;
    }
    if (toks[i] !== 'push') continue;
    const args = toks.slice(i + 1);
    if (args.some((a) => ['-d', '--delete', '--tags'].includes(a))) continue;
    const positional = args.filter((a, k) => !a.startsWith('-') && !PUSH_VALUE.has(args[k - 1]));
    pushes.push({ dir, remote: positional[0] || 'origin', refspecs: positional.slice(1) });
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
// failure), until one succeeds; throws the first error.
function firstThatWorks(more, fn) {
  let first;
  try { return fn({}); } catch (e) { first = e; }
  for (const env of more()) {
    try { return fn(env); } catch (_) { /* next */ }
  }
  throw first;
}

// gh: each logged-in account by its token.
function ghEnvs() {
  const envs = [];
  let status = '';
  try {
    status = execFileSync('gh', ['auth', 'status'], { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) { status = `${e.stdout || ''}${e.stderr || ''}`; }
  for (const m of status.matchAll(/account\s+(\S+)/g)) {
    try { envs.push({ GH_TOKEN: run('gh', ['auth', 'token', '--user', m[1]]) }); } catch (_) { /* skip */ }
  }
  return envs;
}

// glab: each ~/.config/glab-* config dir.
function glabEnvs(home = os.homedir()) {
  const dir = path.join(home, '.config');
  let extra = [];
  try { extra = fs.readdirSync(dir).filter((d) => /^glab-/.test(d)).map((d) => ({ GLAB_CONFIG_DIR: path.join(dir, d) })); } catch (_) { /* none */ }
  return extra;
}

const runEnv = (cmd, args, cwd, env) =>
  execFileSync(cmd, args, { cwd, env: { ...process.env, ...env }, encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();

// Returns [{ id, state }] with state normalised to OPEN / MERGED / CLOSED.
function reviewsFor(dir, remote, branch, { gh = ghEnvs, glab = glabEnvs } = {}) {
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
  const why = (e) => String((e && e.message) || e).split('\n')[0].slice(0, 160);
  for (const push of findPushes(command, cwd)) {
    let names = [];
    try { names = branches(push); } catch (e) { blind.push(`nhánh ở ${push.dir}: ${why(e)}`); }
    for (const branch of names) {
      if (!branch || branch === 'HEAD') continue;
      let found;
      try { found = reviews(push.dir, push.remote, branch); } catch (e) { blind.push(`"${branch}" (${push.remote}): ${why(e)}`); continue; }
      if (found.length === 0 || found.some((r) => r.state === 'OPEN')) continue;
      return { block: `push-after-pr-guard: branch "${branch}" already had ${found.map((r) => `${r.id} ${r.state}`).join(', ')}. ` +
        "Push the follow-up to a new branch from the target's current tip and open a new PR/MR.\n" };
    }
  }
  return { blind };
}

module.exports = { findPushes, expand, branchesOf, reviewsFor, firstThatWorks, glabEnvs, decide };
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
