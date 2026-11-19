#!/usr/bin/env node
/**
 * watch-guard.cjs - PreToolUse(Bash). Commands are read with lib/shell-words.cjs, so a loop inside a
 * quoted script (`ssh host 'for …'`), a heredoc for another program or an argument string is text,
 * not a loop of this shell.
 * - Always blocks what locks the session while the user cannot type: an explicit foreground
 *   `timeout` over 120000 ms, or the watch.sh loop in the foreground (only --once/--help run there).
 * - Blocks once with a reminder (lib/block-once.cjs; the same command run again passes): a
 *   foreground loop of this shell around remote calls (ssh, docker exec, gh/glab api, airflow)
 *   unless it is a `for` over up to 5 items written out with no `sleep`, a foreground
 *   `while/until … sleep` poll, a background `sleep` or `while/until` loop that sleeps or calls out
 *   (not `while read` over input) not through ~/.claude/scripts/watch.sh,
 *   and a background watch.sh whose first report (the sooner of `--deadline` and `--checkpoint`)
 *   outlives the Bash `timeout` (default 1800000 ms), which would kill the watcher before it reports.
 * An omitted foreground timeout is the harness default (120000 ms) and passes. Script files the
 * command runs are read the same way. `# watch-exempt: <reason>` lets a legitimate loop through.
 * Fails open on unreadable input.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { expandHome, samePath } = require('./lib/platform.cjs');
const { commands, program, innerScript } = require('./lib/shell-words.cjs');

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
// loop, poll: one with a `sleep`, sleeps: a `sleep` command, remote: a remote call, loopRemote: a
// remote call inside a loop's own commands (one before or after the loop runs once), longRemote: one
// inside a loop whose length is not written out (`while`, `$(…)`, a glob, over 5 items) or whose body
// sleeps, waitRemote: one inside a `while/until` loop }. `deep` also reads the scripts handed to
// another machine for waits (`ssh h 'while …; sleep 5; done'` polls too).
function shape(text, deep = true) {
  const inner = deep ? remoteScripts(text).map((t) => shape(t, false)) : [];
  const all = commands(text);
  // A script this shell runs in its own place (`bash -c '<s>'`, `eval <s>`) is this shell's work.
  const own = all.map(program).map(innerScript).filter((t) => t !== null).map((t) => shape(t, deep));
  const first = (w) => w.find((x) => !/^(\{|\(|!|time)$/.test(x));
  const loops = all.map(first).filter((w) => /^(for|while|until)$/.test(w || ''));
  const progs = all.map(program);
  const sleeps = progs.some((w) => w[0] === 'sleep');
  const isRemote = (w) => w[0] === 'ssh' || w[0] === 'airflow' ||
    (w[0] === 'docker' && w[1] === 'exec') || ((w[0] === 'gh' || w[0] === 'glab') && w[1] === 'api');
  const remote = progs.some(isRemote);
  // Commands come flat in order: a loop opens at its `for/while/until` and closes at `done`.
  // A nested loop's header follows a keyword (`do for …`, `then while …`).
  const head = (w) => w.find((x) => !/^(\{|\(|!|time|do|then|else|elif)$/.test(x));
  // `for x in a b c`: at most 5 items, none expanded when it runs (`$`, backtick, glob, brace).
  const listed = (rest) => rest[1] === 'in' && rest.length > 2 && rest.length <= 7 &&
    rest.slice(2).every((x) => !/[$`*?[{(]/.test(x));
  const open = [];
  let loopRemote = false;
  let longRemote = false;
  let waitRemote = false;
  const close = (l) => { if (l.remote && (!l.listed || l.sleeps)) longRemote = true; };
  all.forEach((w, k) => {
    const h = head(w) || '';
    if (/^(for|while|until)$/.test(h)) {
      open.push({ kind: h, listed: h === 'for' && listed(w.slice(w.indexOf(h) + 1)), remote: false, sleeps: false });
    }
    if (open.length && isRemote(progs[k])) {
      loopRemote = true;
      if (open.some((l) => l.kind !== 'for')) waitRemote = true;
      open.forEach((l) => { l.remote = true; });
    }
    if (open.length && progs[k][0] === 'sleep') open.forEach((l) => { l.sleeps = true; });
    if (w[0] === 'done' && open.length) close(open.pop());
  });
  open.forEach(close);
  const wait = loops.some((w) => w !== 'for') || inner.some((x) => x.wait) || own.some((x) => x.wait);
  const poll = (loops.some((w) => w !== 'for') && sleeps) || inner.some((x) => x.poll) || own.some((x) => x.poll);
  return {
    loop: loops.length > 0 || own.some((x) => x.loop),
    wait,
    poll,
    sleeps: sleeps || inner.some((x) => x.sleeps) || own.some((x) => x.sleeps),
    remote: remote || own.some((x) => x.remote),
    loopRemote: loopRemote || own.some((x) => x.loopRemote),
    longRemote: longRemote || own.some((x) => x.longRemote),
    waitRemote: waitRemote || inner.some((x) => x.waitRemote) || own.some((x) => x.waitRemote),
  };
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
      // A watcher reports at the sooner of its --deadline (TIMEOUT) and its --checkpoint (default 600 s).
      const secs = (d) => {
        const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(d || '');
        return d && m ? Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0) : null;
      };
      const reportsAt = (args) => {
        const checkpoint = Number((/--checkpoint[ =](\d+)/.exec(args) || [])[1] || 600);
        const deadline = secs((/--deadline[ =](\S+)/.exec(args) || [])[1]);
        return deadline ? Math.min(checkpoint, deadline) : checkpoint;
      };
      const wake = Math.max(...runs.map(reportsAt));
      const want = Math.min(wake * 1000 + 300000, MAX_TIMEOUT_MS);
      if (bg && wake * 1000 + 60000 > limit && want > limit) {
        once(`watch-guard: the watcher first reports after ${wake} s (the sooner of --deadline and --checkpoint), ` +
          `past this call's timeout (${limit} ms): the harness would stop it before it reports. ` +
          `Pass \`timeout: ${want}\` with run_in_background.`);
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
    if (!bg && shapes.some((x) => x.longRemote)) {
      once('watch-guard: this foreground loop makes remote calls one after another and can hold the session. ' +
        'Make the remote reads one call (one query, one API list, one ssh with the loop inside), or run it in the background. ' +
        'A `for` over up to 5 items written out, with no `sleep`, passes.');
    }
    // In the background, a loop waits when it sleeps or calls out each round; `while read` over input does not.
    if (!shapes.some((x) => (bg ? x.poll || x.waitRemote || x.sleeps : x.poll))) process.exit(0);
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
