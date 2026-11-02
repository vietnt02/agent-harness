#!/usr/bin/env node
/**
 * open-browser-guard.cjs - PreToolUse(Bash): keep pages for the user inside Orca, in this session's
 * worktree (knowledge/browser-debug.md § Verify UI).
 * - `open` given an http(s) URL or a .html file opens the user's default browser, which is not
 *   their work browser (`-a <app>` / `--args` included: the page still opens; `-R`, `-e`, `-t` pass).
 * - `orca tab create` / `orca goto` without `--worktree` (or `goto --page`) land in whichever
 *   worktree Orca calls current, often the `~` folder context, not the session's card.
 * Only words in command position count (lib/shell-words.cjs): a URL inside `echo`, `grep` or a
 * commit message passes. Limit: `open "$URL"` and `… | xargs open` are not caught, the URL is not
 * visible. Fails open.
 */
const { commands, program } = require('./lib/shell-words.cjs');

const PAGE = /^(https?:\/\/|file:\/\/.*\.html?([#?]|$))|\.html?([#?].*)?$/i;

function problem(command, cwd) {
  const where = `--worktree path:${cwd || '<cwd phiên>'}`;
  for (const words of commands(command).map(program)) {
    const [name, ...rest] = words;
    const args = name === 'orca' ? rest.filter((a, k) => k >= rest.findIndex((w) => !w.startsWith('-'))) : rest;
    // -R reveals in Finder, -e/-t open a text editor: no browser.
    if (name === 'open' && !args.some((a) => /^-[a-zA-Z]*[Ret]/.test(a) && !a.startsWith('--')) && args.some((a) => PAGE.test(a))) {
      return `"open" with a URL or .html opens the user's default browser, not their work browser. ` +
        `Only open a page when the user asks, and then in Orca: orca tab create ${where} --url <url> ` +
        '(check `orca tab list` first).';
    }
    const isTab = name === 'orca' && args[0] === 'tab' && args[1] === 'create';
    const isGoto = name === 'orca' && args[0] === 'goto';
    const has = (flag) => args.some((a) => a === flag || a.startsWith(flag + '='));
    if ((isTab || isGoto) && !has('--worktree') && !(isGoto && has('--page'))) {
      return `"${words.join(' ')}" has no --worktree, so the tab lands in Orca's current worktree ` +
        `(often the ~ folder), not this session's. Add ${where}.`;
    }
  }
  return null;
}

if (require.main === module) {
  let raw = '';
  process.stdin.on('data', (c) => (raw += c));
  process.stdin.on('end', () => {
    try {
      const data = JSON.parse(raw);
      if (data.tool_name !== 'Bash') process.exit(0);
      const why = problem((data.tool_input || {}).command || '', process.env.CLAUDE_PROJECT_DIR || data.cwd);
      if (why) {
        process.stderr.write(`open-browser-guard: ${why}\n`);
        process.exit(2);
      }
    } catch (_) { /* fail-open */ }
    process.exit(0);
  });
}

module.exports = { problem };
