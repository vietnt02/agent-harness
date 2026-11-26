#!/usr/bin/env node
'use strict';
/**
 * heavy-reminder.cjs - PreToolUse(Bash). A common heavy command (a build, a full test suite, a
 * dependency install) run without ~/.claude/scripts/heavy.cjs gets one reminder per session, as
 * context: the command runs anyway, since a build outside a slot harms nothing that cannot be
 * undone, and the reminder reaches the agent before its next heavy command (ntv-orca § 2).
 * Commands are read with lib/shell-words.cjs, so a name inside a quoted string is text; a
 * `bash -c '<script>'` is read as its script. A command that already names heavy.cjs passes.
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
const TOOL = /^(?:vitest|jest|pytest)$/;

// The words of a heavy command, or null: a package manager's build, test or install, a test runner,
// `next build`, `playwright test`, `python -m pytest`.
function heavyIn(words) {
  let w = program(words);
  if (!w.length) return null;
  if (RUNNER.test(w[0]) || (PM.test(w[0]) && (w[1] === 'exec' || w[1] === 'dlx'))) {
    w = w.slice(RUNNER.test(w[0]) ? 1 : 2).filter((x, i, all) => !(i === 0 && x.startsWith('-') && all.length > 1));
  }
  const [p, a, b] = w;
  if (PM.test(p)) {
    if (a === undefined) return p === 'yarn' || p === 'bun' ? w : null;
    if (a === 'run' || a === 'run-script') return /^(?:build|test)(?::|$)/.test(b || '') ? w : null;
    return /^(?:build|test|t|ci|install|i)$/.test(a) ? w : null;
  }
  if (TOOL.test(p)) return w;
  if (p === 'next' && a === 'build') return w;
  if (p === 'playwright' && a === 'test') return w;
  if (/^python3?$/.test(p) && a === '-m' && b === 'pytest') return w;
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
  if (!command || /heavy\.cjs\b/.test(command)) return;
  const hit = findHeavy(command);
  if (!hit || !firstInSession(payload.session_id)) return;
  const text = `heavy-reminder: \`${hit.slice(0, 80)}\` is a heavy command (a build, a full test suite, a dependency ` +
    'install). Run such commands through `node ~/.claude/scripts/heavy.cjs -- <command>` (a compound one: ' +
    '`-- sh -c \'<command>\'`), so the agents on this machine take turns instead of building at once ' +
    '(ntv-orca § 2). A dev server takes no slot. Said once this session.';
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
