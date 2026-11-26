#!/usr/bin/env node
'use strict';
/**
 * heavy-reminder.cjs - PreToolUse(Bash). A common heavy command (a build, a full test suite, a
 * typecheck, a dependency install) run without ~/.claude/scripts/heavy.cjs gets one reminder per session, as
 * context: the command runs anyway, since a build outside a slot harms nothing that cannot be
 * undone, and the reminder reaches the agent before its next heavy command (ntv-orca § 2).
 * Commands are read with lib/shell-words.cjs, so a name inside a quoted string is text; a
 * `bash -c '<script>'` is read as its script; a command already run through heavy.cjs is `node`, so it
 * passes. A watcher or a dev server is no heavy command: it would hold a slot for the whole task.
 * agy reaches it through agy/claude-hook-bridge.cjs (run_command), dispatched workers included.
 * Fails open on unreadable input.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { commands, program, innerScript } = require('./lib/shell-words.cjs');

const DIR = path.join(os.tmpdir(), 'claude-heavy-reminder');
const PM = /^(?:npm|pnpm|yarn|bun)$/;
const RUNNER = /^(?:npx|pnpx|bunx)$/;
// Options a package manager takes before its subcommand, with a value (`pnpm -C app build`).
const PM_VALUE = new Set(['-C', '--dir', '--filter', '-F', '--prefix', '-w', '--workspace', '--cwd']);
// A watcher or a server runs for the whole task: it takes no slot, so it is never "heavy" here.
const LONG_RUNNING = (words) => words.some((x) => /^--watch(?:All)?(?:=|$)/.test(x)) ||
  words.some((x, i) => i > 0 && /(?:^|:)(?:watch|dev|serve|start)(?::|$)/.test(x));

// The words of a heavy command, or null: a package manager's build, test, typecheck or install, a test
// runner, `tsc`, `next build`, `playwright test`, `python -m pytest`, `uv run …`.
function heavyIn(words, depth = 0) {
  let w = program(words);
  if (!w.length) return null;
  if (RUNNER.test(w[0])) w = w.slice(1).filter((x, i) => !(i === 0 && x.startsWith('-')));
  if (w[0] === 'uv' && w[1] === 'run' && depth < 2) return heavyIn(w.slice(2).filter((x) => !x.startsWith('-')), depth + 1);
  if (!w.length || LONG_RUNNING(w)) return null;
  const p = w[0];
  if (PM.test(p)) {
    const rest = [];
    for (let i = 1; i < w.length; i++) {
      if (PM_VALUE.has(w[i]) && !(w[i] === '-w' && p !== 'npm')) { i++; continue; }
      if (w[i].startsWith('-') && !rest.length) continue;
      if (p === 'yarn' && w[i] === 'workspace' && !rest.length) { i++; continue; }
      rest.push(w[i]);
    }
    const [a, b] = rest;
    if (a === undefined) return p === 'yarn' ? w : null;
    if (a === 'exec' || a === 'dlx') return depth < 2 ? heavyIn(rest.slice(1), depth + 1) : null;
    if (a === 'run' || a === 'run-script') return /^(?:build|test|typecheck|type-check)(?::|$)/.test(b || '') ? w : null;
    return /^(?:build|test|t|ci|install|i)$/.test(a) ? w : null;
  }
  const [, a] = w;
  if (p === 'vitest') return a === 'run' || w.includes('--run') ? w : null;
  if (p === 'jest' || p === 'pytest') return w;
  if (p === 'tsc') return w.some((x) => /^(?:-v|--version|-h|--help|--init)$/.test(x)) ? null : w;
  if (p === 'next' && a === 'build') return w;
  if (p === 'playwright' && a === 'test') return w;
  if (/^python3?$/.test(p) && a === '-m' && w[2] === 'pytest') return w;
  return null;
}

function findHeavy(command, depth = 0) {
  for (const words of commands(command)) {
    const hit = heavyIn(words);
    if (hit) return hit.join(' ');
    const inner = depth < 2 ? innerScript(words) : null;
    if (inner) {
      const deeper = findHeavy(inner, depth + 1);
      if (deeper) return deeper;
    }
  }
  return null;
}

// True the first time this session is reminded; false after. No session id: always true.
function firstInSession(sessionId) {
  if (!sessionId) return true;
  const file = path.join(DIR, String(sessionId).replace(/[^\w-]/g, '_'));
  if (fs.existsSync(file)) return false;
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(file, String(Date.now()));
  } catch (_) { /* reminded again next time: harmless */ }
  return true;
}

function main(raw) {
  let payload;
  try { payload = JSON.parse(raw || '{}'); } catch (_) { return; }
  if (payload.tool_name !== 'Bash') return;
  const command = String((payload.tool_input || {}).command || '');
  if (!command) return;
  const hit = findHeavy(command);
  if (!hit || !firstInSession(payload.session_id)) return;
  const text = `heavy-reminder: \`${hit.slice(0, 80)}\` is a heavy command (a build, a full test suite, a typecheck, ` +
    'a dependency install). Run such commands through `node ~/.claude/scripts/heavy.cjs -- <command>` (a compound ' +
    'one: `-- sh -c \'<command>\'`, on Windows `-- cmd /c "<command>"`), in the background when it may wait for a ' +
    'slot, so the agents on this machine take turns instead of building at once (ntv-orca § 2). A dev server or a ' +
    'watcher takes no slot. Said once this session.';
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: text } }));
}

if (require.main === module) {
  let raw = '';
  process.stdin.on('data', (d) => { raw += d; });
  process.stdin.on('end', () => {
    try { main(raw); } catch (_) { /* fail open */ }
  });
}
module.exports = { findHeavy };
