#!/usr/bin/env node
/**
 * watch-guard.cjs - PreToolUse(Bash). Commands are read with lib/shell-words.cjs, so a loop inside a
 * quoted script (`ssh host 'for …'`), a heredoc for another program or an argument string is text,
 * not a loop of this shell.
 * - Always blocks what locks the session while the user cannot type: an explicit foreground
 *   `timeout` over 120000 ms, or the watch.sh loop in the foreground (only --once/--help run there).
 * - Blocks once with a reminder (lib/block-once.cjs; the same command run again passes): a
 *   foreground loop of this shell around remote calls (ssh, docker exec, gh/glab api, airflow), a
 *   foreground `while/until … sleep` poll, a background loop not through ~/.claude/scripts/watch.sh,
 *   and a background watch.sh whose `--checkpoint` outlives the Bash `timeout` (default 1800000 ms),
 *   which would kill the watcher before it reports.
 * An omitted foreground timeout is the harness default (120000 ms) and passes. Script files the
 * command runs are read the same way. `# watch-exempt: <reason>` lets a legitimate loop through.
 * Fails open on unreadable input.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { expandHome, samePath } = require('./lib/platform.cjs');
const { commands, program } = require('./lib/shell-words.cjs');

const EXEMPT = /#\s*watch-exempt:\s*\S/;
const BG_TIMEOUT_MS = 1800000;
const MAX_TIMEOUT_MS = 7200000;
const FG_TIMEOUT_MS = 120000;
const WATCH_PATH = path.join(os.homedir(), '.claude', 'scripts', 'watch.sh');

// A script path in command position, or after runners (`bash -x`, `source`, `.`, `timeout 600`,
// `env`); a path handed to a reader (`sed -n 1,9p w.sh`, `grep x w.sh`) is not run, so not scanned.
const RUNS = /(?:^|[;&|(\n]|\bthen|\bdo)\s*(?:\w+=\S*\s+)*(?:(?:bash|sh|zsh|source|exec|nohup|command|env|timeout(?:\s+-\S+)*\s+\S+|\.)(?:\s+-\S+)*\s+)*$/;
const expand = (p) => expandHome(p.replace(/^(?:\$HOME|\$\{HOME\})(?=[/\\])/, os.homedir()));
// `bash -n x.sh` only checks syntax.
const isRun = (before) => RUNS.test(before) && !/\b(?:ba|z)?sh(?:\s+-\S+)*\s+-\w*n\w*\s+$/.test(before);
const dropHeredocs = (s) => s.replace(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n[ \t]*\2[ \t]*(?=\n|$)/g, '<<heredoc');

// The scripts the command hands another machine or shell to run: `ssh host '<s>'`, and a heredoc
// body fed to `ssh host` or `sudo … -s` (a heredoc fed to bash/sh is read by shell-words already).
function remoteScripts(text) {
  const out = [];
  for (const words of commands(text).map(program)) {
    if (words[0] !== 'ssh') continue;
    const rest = words.slice(1).filter((a, k, all) => !a.startsWith('-') && !/^-[bcDEeFIiJLlmOopQRSWw]$/.test(all[k - 1] || ''));
    if (rest.length > 1) out.push(rest.slice(1).join(' '));
  }
  const fed = /(?:\bssh(?:\s+-\S+(?:\s+[^\s-]\S*)?)*\s+[^\s<-]\S*|\bsudo\b[^\n<]*\s-s)\s*<<-?\s*(['"]?)(\w+)\1[^\n]*\n([\s\S]*?)\n[ \t]*\2[ \t]*(?=\n|$)/g;
  for (const m of text.matchAll(fed)) out.push(m[3]);
  return out;
}

// What the shell itself runs: { loop: a `for/while/until` of this shell, wait: a `while/until`
// loop, poll: one with a `sleep`, sleeps: a `sleep` command, remote: a remote call }. `deep` also
// reads the scripts handed to another machine for waits (`ssh h 'while …; sleep 5; done'` polls too).
function shape(text, deep = true) {
  const inner = deep ? remoteScripts(text).map((t) => shape(t, false)) : [];
  const all = commands(text);
  const first = (w) => w.find((x) => !/^(\{|\(|!|time)$/.test(x));
  const loops = all.map(first).filter((w) => /^(for|while|until)$/.test(w || ''));
  const progs = all.map(program);
  const sleeps = progs.some((w) => w[0] === 'sleep');
  const remote = progs.some((w) => w[0] === 'ssh' || w[0] === 'airflow' ||
    (w[0] === 'docker' && w[1] === 'exec') || ((w[0] === 'gh' || w[0] === 'glab') && w[1] === 'api'));
  const wait = loops.some((w) => w !== 'for') || inner.some((x) => x.wait);
  const poll = (loops.some((w) => w !== 'for') && sleeps) || inner.some((x) => x.poll);
  return { loop: loops.length > 0, wait, poll, sleeps: sleeps || inner.some((x) => x.sleeps), remote };
}

// The arguments of each place the command runs watch.sh, up to the next separator; quoted
// strings are blanked first, so `--check "x --once"` does not count as --once.
function watchRuns(text, cwd) {
  const command = dropHeredocs(text);
  const runs = [];
  for (const m of command.matchAll(/(["']?)([^\s'";|&()]*watch\.sh)\1(?=[\s;|&)]|$)/g)) {
    if (!samePath(path.resolve(cwd, expand(m[2])), WATCH_PATH) || !isRun(command.slice(0, m.index))) continue;
    const rest = command.slice(m.index + m[0].length).replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '""');
    const end = rest.search(/[;&|\n]/);
    runs.push(end === -1 ? rest : rest.slice(0, end));
  }
  return runs;
}

// Script files the command runs, e.g. `bash /tmp/w.sh` or `./w.sh`.
function scriptsIn(text, cwd) {
  const command = dropHeredocs(text);
  return [...command.matchAll(/[^\s'";|&()]+\.(?:sh|bash|zsh)\b/g)]
    .filter((m) => isRun(command.slice(0, m.index)))
    .map((m) => path.resolve(cwd, expand(m[0])))
    .filter((p) => !samePath(p, WATCH_PATH))
    .filter((p) => { try { return fs.statSync(p).size < 200000; } catch (_) { return false; } })
    .map((p) => fs.readFileSync(p, 'utf8'));
}

module.exports = { watchRuns, scriptsIn, expand, shape };
if (require.main !== module) return;

let raw = '';
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', () => {
  try {
    const { tool_name: tool, tool_input: input = {}, cwd, session_id: sessionId } = JSON.parse(raw);
    const command = input.command || '';
    if (tool !== 'Bash') process.exit(0);
    const bg = !!input.run_in_background;
    const { firstTime, again } = require('./lib/block-once.cjs');
    const once = (msg) => {
      if (!firstTime(sessionId, 'watch-guard', command)) process.exit(0);
      process.stderr.write(msg + again(sessionId) + '\n');
      process.exit(2);
    };
    const runs = watchRuns(command, cwd || process.cwd());
    if (runs.length) {
      // The loop blocks the session while the user waits: only --once (or --help) runs in the foreground.
      if (!bg && runs.some((args) => !/(?:^|\s)--(?:once|help)\b/.test(args))) {
        process.stderr.write('watch-guard: the watch.sh loop runs with run_in_background, never in the ' +
          'foreground: report what is ready first, then wait in the background. Foreground is only for --once.\n');
        process.exit(2);
      }
      const limit = Number(input.timeout) || BG_TIMEOUT_MS;
      const checkpoint = Math.max(...runs.map((args) => Number((/--checkpoint[ =](\d+)/.exec(args) || [])[1] || 600)));
      if (bg && checkpoint * 1000 + 60000 > limit) {
        const want = Math.min(checkpoint * 1000 + 300000, MAX_TIMEOUT_MS);
        once(`watch-guard: --checkpoint ${checkpoint} s outlives this call's timeout (${limit} ms): the harness ` +
          `would stop the watcher before it reports. Pass \`timeout: ${want}\` with run_in_background.`);
      }
      process.exit(0);
    }
    const sources = [command, ...scriptsIn(command, cwd || process.cwd())];
    if (sources.some((s) => EXEMPT.test(s))) process.exit(0);
    if (!bg && Number(input.timeout) > FG_TIMEOUT_MS) {
      process.stderr.write('watch-guard: a foreground timeout over 120000 ms locks the session while the user cannot ' +
        'type. Run it with run_in_background: true; a run you wait on: watch.sh --once.\n');
      process.exit(2);
    }
    const shapes = sources.map((x) => shape(x));
    if (!bg && shapes.some((x) => x.loop && x.remote)) {
      once('watch-guard: this foreground loop makes remote calls one after another and can hold the session. ' +
        'Make the remote reads one call (one query, one API list, one ssh with the loop inside), or run it in the background.');
    }
    if (!shapes.some((x) => (bg ? x.wait || x.sleeps : x.poll))) process.exit(0);
    once(
      (bg ? 'watch-guard: background loops go through ~/.claude/scripts/watch.sh (see --help): '
        : 'watch-guard: a foreground `while/until … sleep` poll has no deadline of its own. ' +
          'Bound it (`for i in $(seq 1 N)`) or go through ~/.claude/scripts/watch.sh (see --help): ') +
      'run it with --once in the foreground, then the same command in the background. ' +
      'A loop that is not waiting on external state: add `# watch-exempt: <reason>`. ' +
      'A wait watch.sh cannot express is a kaizen: see the end of watch.sh --help.'
    );
  } catch (_) { /* fail-open: malformed hook input */ }
});
