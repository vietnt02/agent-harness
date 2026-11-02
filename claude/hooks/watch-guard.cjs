#!/usr/bin/env node
/**
 * watch-guard.cjs - PreToolUse(Bash): block a background command that loops, or a foreground
 * one that polls (`while/until … do … sleep`), inline or in a script file it runs, unless
 * it goes through ~/.claude/scripts/watch.sh, whose allowlist exits on anything unexpected
 * instead of waiting on it silently (skills/ntv-implement).
 * Also blocks, in the foreground, what locks the session while the user cannot type: an explicit
 * `timeout` over 120000 ms, or remote calls (ssh, docker exec, gh/glab api, airflow) inside a loop.
 * An omitted timeout is the harness default (120000 ms) and passes.
 * `# watch-exempt: <reason>` in the command or the script lets a legitimate loop through.
 * Fails open on unreadable input.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { expandHome, samePath } = require('./lib/platform.cjs');

const LOOP = /\b(while|until)\b[\s\S]*\bdo\b|\bsleep\b/;
// Foreground: only an unbounded poll. `while read` (no sleep) and `for i in $(seq 1 N)` pass.
const POLL = /\b(while|until)\b[\s\S]*\bdo\b[\s\S]*\bsleep\b/;
const EXEMPT = /#\s*watch-exempt:\s*\S/;
const ANY_LOOP = /\b(for|while|until)\b[\s\S]*\bdo\b/;
const REMOTE = /\b(ssh|docker\s+exec|gh\s+api|glab\s+api|airflow)\b/;
const FG_TIMEOUT_MS = 120000;
const WATCH_PATH = path.join(os.homedir(), '.claude', 'scripts', 'watch.sh');

// A script path in command position, or after runners (`bash -x`, `source`, `.`, `timeout 600`,
// `env`); a path handed to a reader (`sed -n 1,9p w.sh`, `grep x w.sh`) is not run, so not scanned.
const RUNS = /(?:^|[;&|(\n]|\bthen|\bdo)\s*(?:\w+=\S*\s+)*(?:(?:bash|sh|zsh|source|exec|nohup|command|env|timeout(?:\s+-\S+)*\s+\S+|\.)(?:\s+-\S+)*\s+)*$/;
const expand = (p) => expandHome(p.replace(/^(?:\$HOME|\$\{HOME\})(?=[/\\])/, os.homedir()));
// `bash -n x.sh` only checks syntax.
const isRun = (before) => RUNS.test(before) && !/\b(?:ba|z)?sh(?:\s+-\S+)*\s+-\w*n\w*\s+$/.test(before);
// A heredoc body is data for another program (`python3 - <<'EOF'`), not shell to run.
const dropHeredocs = (s) => s.replace(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n[ \t]*\2[ \t]*(?=\n|$)/g, '<<heredoc');

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

module.exports = { watchRuns, scriptsIn, expand };
if (require.main !== module) return;

let raw = '';
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', () => {
  try {
    const { tool_name: tool, tool_input: input = {}, cwd } = JSON.parse(raw);
    const command = input.command || '';
    if (tool !== 'Bash') process.exit(0);
    const bg = !!input.run_in_background;
    const runs = watchRuns(command, cwd || process.cwd());
    if (runs.length) {
      // The loop blocks the session while the user waits: only --once (or --help) runs in the foreground.
      if (!bg && runs.some((args) => !/(?:^|\s)--(?:once|help)\b/.test(args))) {
        process.stderr.write('watch-guard: the watch.sh loop runs with run_in_background, never in the ' +
          'foreground: report what is ready first, then wait in the background. Foreground is only for --once.\n');
        process.exit(2);
      }
      process.exit(0);
    }
    const pattern = bg ? LOOP : POLL;
    const sources = [command, ...scriptsIn(command, cwd || process.cwd())];
    if (sources.some((s) => EXEMPT.test(s))) process.exit(0);
    if (!bg && (Number(input.timeout) > FG_TIMEOUT_MS || sources.some((s) => ANY_LOOP.test(s) && REMOTE.test(s)))) {
      process.stderr.write('watch-guard: this foreground command can lock the session while the user cannot ' +
        'type (timeout over 120000 ms, or remote calls inside a loop). Run it with run_in_background: true, ' +
        'or make the remote reads one call (one query, one API list). A run you wait on: watch.sh --once.\n');
      process.exit(2);
    }
    if (!sources.some((s) => pattern.test(s))) process.exit(0);
    process.stderr.write(
      (bg ? 'watch-guard: background loops go through ~/.claude/scripts/watch.sh (see --help): '
        : 'watch-guard: a foreground `while/until … sleep` poll has no deadline of its own. ' +
          'Bound it (`for i in $(seq 1 N)`) or go through ~/.claude/scripts/watch.sh (see --help): ') +
      'run it with --once in the foreground, then the same command in the background. ' +
      'A loop that is not waiting on external state: add `# watch-exempt: <reason>`. ' +
      'A wait watch.sh cannot express is a kaizen: see the end of watch.sh --help.\n'
    );
    process.exit(2);
  } catch (_) { /* fail-open: malformed hook input */ }
});
