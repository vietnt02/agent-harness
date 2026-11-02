#!/usr/bin/env node
/**
 * push-after-pr-guard.cjs - PreToolUse(Bash): block `git push` to a branch whose PR/MR
 * is already merged or closed, so follow-ups go to a new branch (CLAUDE.md § Irreversible
 * actions, push after a PR). Fails open whenever the branch or PR state cannot be determined.
 */
const { execFileSync } = require('child_process');
const os = require('os');
const path = require('path');

const run = (cmd, args, cwd) =>
  execFileSync(cmd, args, { cwd, encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();

const unquote = (t) => t.replace(/^(['"])(.*)\1$/, '$2');
const expand = (dir, cwd) => path.resolve(cwd, unquote(dir).replace(/^~(?=$|\/)/, os.homedir()));

// Each `git push` in the command, with the directory it runs in.
function findPushes(command, startCwd) {
  const pushes = [];
  let cwd = startCwd;
  for (const seg of command.split(/&&|\|\||;|\n|\|/)) {
    const toks = (seg.match(/"[^"]*"|'[^']*'|\S+/g) || []).map(unquote);
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
    const positional = args.filter((a) => !a.startsWith('-'));
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

// Returns [{ id, state }] with state normalised to OPEN / MERGED / CLOSED.
function reviewsFor(dir, remote, branch) {
  const url = run('git', ['remote', 'get-url', remote], dir);
  if (/gitlab/.test(url)) {
    const mrs = JSON.parse(run('glab', ['mr', 'list', '--source-branch', branch, '--all', '-F', 'json'], dir));
    return mrs.map((m) => ({ id: `!${m.iid}`, state: { opened: 'OPEN' }[m.state] || m.state.toUpperCase() }));
  }
  const prs = JSON.parse(run('gh', ['pr', 'list', '--head', branch, '--state', 'all', '--json', 'number,state'], dir));
  return prs.map((p) => ({ id: `#${p.number}`, state: p.state }));
}

let raw = '';
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', () => {
  try {
    const { tool_name: tool, tool_input: input = {}, cwd } = JSON.parse(raw);
    if (tool !== 'Bash' || !/\bgit\b[^\n]*\bpush\b/.test(input.command || '')) process.exit(0);
    for (const push of findPushes(input.command, cwd || process.cwd())) {
      for (const branch of branchesOf(push)) {
        if (!branch || branch === 'HEAD') continue;
        const reviews = reviewsFor(push.dir, push.remote, branch);
        if (reviews.length === 0 || reviews.some((r) => r.state === 'OPEN')) continue;
        const list = reviews.map((r) => `${r.id} ${r.state}`).join(', ');
        process.stderr.write(
          `push-after-pr-guard: branch "${branch}" already had ${list}. Push the follow-up to a new branch from the target's current tip and open a new PR/MR.\n`
        );
        process.exit(2);
      }
    }
  } catch (_) { /* fail-open: unknown branch, no gh/glab, no network */ }
  process.exit(0);
});
